/**
 * Memory + hub enrollment routes, with a configurable central memory root
 * and an auto-sync switch (writes sync-rule blocks into agent entry files).
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { enrollAgent, hubStatus, setMemorySyncRule, unenrollAgent } from '@agora/hub';
import { MemoryStore, defaultMemoryRoot, syncAgentMemories, type MemoryScope, type MemoryWriteInput } from '@agora/memory';

interface HubConfig {
  memoryRoot?: string;
  autoSync: boolean;
  /** Auto-sync interval in minutes (default 10, min 1, max 1440). */
  syncIntervalMinutes?: number;
  /**
   * Auto-enroll installed agents on server start (register hub MCP + inject
   * the guide block). Default ON; set false to manage enrollment manually.
   */
  autoEnroll?: boolean;
}

function configPath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'config.json');
}

export function readHubConfig(): HubConfig {
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HubConfig>;
    const out: HubConfig = { autoSync: parsed.autoSync === true };
    if (parsed.memoryRoot) out.memoryRoot = parsed.memoryRoot;
    if (typeof parsed.syncIntervalMinutes === 'number' && parsed.syncIntervalMinutes >= 1) {
      out.syncIntervalMinutes = Math.min(parsed.syncIntervalMinutes, 1440);
    }
    if (parsed.autoEnroll !== undefined) out.autoEnroll = parsed.autoEnroll === true;
    return out;
  } catch {
    return { autoSync: false };
  }
}

export const DEFAULT_SYNC_INTERVAL_MINUTES = 10;

/** Live memory-root accessor shared with hubRoutes (set by memoryRoutes). */
let activeMemoryRoot: () => string = () => defaultMemoryRoot();

function writeHubConfig(config: HubConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function memoryRoutes(db: Database.Database): Hono {
  const app = new Hono();
  let config = readHubConfig();
  let store = new MemoryStore(db, config.memoryRoot ?? defaultMemoryRoot());
  // Share the live root with hubRoutes' enroll endpoint (config may change it).
  activeMemoryRoot = () => store.root;
  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing: Promise<Awaited<ReturnType<typeof syncAgentMemories>>> | null = null;

  // Single-flight: manual /sync, interval autoSync, and boot autoSync all
  // share one execution instead of racing the store's write lock.
  const runSync = () => {
    if (!syncing) {
      syncing = syncAgentMemories(store).finally(() => {
        syncing = null;
      });
    }
    return syncing;
  };

  const stopAutoSync = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const applyAutoSync = async (enabled: boolean) => {
    stopAutoSync();
    const agents = (await hubStatus()).map((a) => a.agent);
    for (const agentId of agents) {
      await setMemorySyncRule(agentId, store.root, enabled).catch(() => null);
    }
    if (enabled) {
      void runSync();
      const intervalMs = (config.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES) * 60 * 1000;
      timer = setInterval(() => void runSync().catch(() => null), intervalMs);
      timer.unref();
    }
  };

  // Auto-enroll: on server start, enroll every installed & writable agent
  // that isn't fully enrolled yet. Idempotent (noop when already enrolled).
  const runAutoEnroll = async (): Promise<{ enrolled: string[]; already: string[]; skipped: string[] }> => {
    const result = { enrolled: [] as string[], already: [] as string[], skipped: [] as string[] };
    if (config.autoEnroll === false) return result;
    const statuses = await hubStatus();
    for (const s of statuses) {
      if (!s.enrollable) {
        result.skipped.push(s.agent);
        continue;
      }
      if (s.mcpRegistered && s.entryBlockPresent) {
        result.already.push(s.agent);
        continue;
      }
      try {
        await enrollAgent(s.agent, store.root);
        result.enrolled.push(s.agent);
      } catch {
        result.skipped.push(s.agent);
      }
    }
    if (result.enrolled.length > 0) {
      console.log(`[agora] 自动接入: ${result.enrolled.join(', ')}`);
    }
    return result;
  };

  // Kick the rule blocks on boot when autoSync is on, and auto-enroll agents.
  if (config.autoSync) {
    void applyAutoSync(true);
  }
  void runAutoEnroll();

  app.get('/config', (c) =>
    c.json({
      rootPath: store.root,
      defaultRoot: defaultMemoryRoot(),
      autoSync: config.autoSync,
      syncIntervalMinutes: config.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
      autoEnroll: config.autoEnroll !== false,
    }),
  );

  app.put('/config', async (c) => {
    const body = await c.req.json<{ rootPath?: string; autoSync?: boolean; syncIntervalMinutes?: number; autoEnroll?: boolean }>();
    const next: HubConfig = { autoSync: body.autoSync ?? config.autoSync };
    if (body.autoEnroll !== undefined) next.autoEnroll = body.autoEnroll;
    else if (config.autoEnroll !== undefined) next.autoEnroll = config.autoEnroll;
    if (body.syncIntervalMinutes !== undefined) {
      if (!Number.isFinite(body.syncIntervalMinutes) || body.syncIntervalMinutes < 1 || body.syncIntervalMinutes > 1440) {
        return c.json({ error: 'syncIntervalMinutes 需在 1-1440 分钟之间' }, 400);
      }
      next.syncIntervalMinutes = Math.round(body.syncIntervalMinutes);
    } else if (config.syncIntervalMinutes !== undefined) {
      next.syncIntervalMinutes = config.syncIntervalMinutes;
    }
    const newRoot = body.rootPath?.trim();
    if (newRoot !== undefined && newRoot.length > 0) {
      if (newRoot !== store.root && existsSync(newRoot) === false) {
        return c.json({ error: `目录不存在: ${newRoot}` }, 400);
      }
      next.memoryRoot = newRoot;
    } else if (config.memoryRoot) {
      next.memoryRoot = config.memoryRoot;
    }
    const rootChanged = next.memoryRoot !== undefined && next.memoryRoot !== store.root;
    const syncChanged = next.autoSync !== config.autoSync;
    const intervalChanged = next.syncIntervalMinutes !== config.syncIntervalMinutes;
    const enrollTurnedOn = body.autoEnroll === true && config.autoEnroll === false;
    config = next;
    writeHubConfig(config);
    if (rootChanged) {
      store = new MemoryStore(db, config.memoryRoot!);
      await store.reindex();
    }
    if (syncChanged || rootChanged || (intervalChanged && config.autoSync)) {
      await applyAutoSync(config.autoSync);
    }
    let enrollReport: { enrolled: string[]; already: string[]; skipped: string[] } | undefined;
    if (enrollTurnedOn) {
      enrollReport = await runAutoEnroll();
    }
    return c.json({
      rootPath: store.root,
      autoSync: config.autoSync,
      syncIntervalMinutes: config.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
      autoEnroll: config.autoEnroll !== false,
      ...(enrollReport !== undefined ? { enrollReport } : {}),
    });
  });

  app.post('/sync', async (c) => c.json(await runSync()));

  app.get('/entries', (c) => {
    const scope = c.req.query('scope') as MemoryScope | undefined;
    const group = c.req.query('group');
    return c.json({ entries: store.list(scope, group ?? undefined) });
  });

  app.get('/groups', (c) => {
    const scope = c.req.query('scope') as MemoryScope | undefined;
    return c.json({ groups: store.groups(scope) });
  });

  app.get('/search', (c) => {
    const q = c.req.query('q') ?? '';
    const scope = c.req.query('scope') as MemoryScope | undefined;
    return c.json({ hits: store.search(q, scope ? { scope } : {}) });
  });

  app.get('/entry', async (c) => {
    const path = c.req.query('path') ?? '';
    const doc = await store.read(path);
    if (!doc) return c.json({ error: '记忆不存在' }, 404);
    return c.json(doc);
  });

  app.post('/entries', async (c) => {
    const body = await c.req.json<MemoryWriteInput>();
    if (!body.name?.trim() || !body.abstract?.trim() || !body.body?.trim()) {
      return c.json({ error: 'name、abstract、body 必填' }, 400);
    }
    try {
      const entry = await store.write({ ...body, by: body.by ?? 'webui' });
      return c.json({ entry }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/entry', async (c) => {
    const path = c.req.query('path') ?? '';
    try {
      const ok = await store.remove(path);
      return c.json({ ok });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/reindex', async (c) => c.json(await store.reindex()));

  return app;
}

export function hubRoutes(): Hono {
  const app = new Hono();

  app.get('/status', async (c) => c.json({ agents: await hubStatus() }));

  app.post('/enroll', async (c) => {
    const body = await c.req.json<{ agent?: string }>();
    if (!body.agent) return c.json({ error: 'agent 必填' }, 400);
    try {
      return c.json(await enrollAgent(body.agent, activeMemoryRoot()));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/unenroll', async (c) => {
    const body = await c.req.json<{ agent?: string }>();
    if (!body.agent) return c.json({ error: 'agent 必填' }, 400);
    try {
      return c.json(await unenrollAgent(body.agent));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
