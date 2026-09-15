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
}

function configPath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'config.json');
}

export function readHubConfig(): HubConfig {
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HubConfig>;
    return { autoSync: parsed.autoSync === true, ...(parsed.memoryRoot ? { memoryRoot: parsed.memoryRoot } : {}) };
  } catch {
    return { autoSync: false };
  }
}

function writeHubConfig(config: HubConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const AUTOSYNC_INTERVAL_MS = 10 * 60 * 1000;

export function memoryRoutes(db: Database.Database): Hono {
  const app = new Hono();
  let config = readHubConfig();
  let store = new MemoryStore(db, config.memoryRoot ?? defaultMemoryRoot());
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
      timer = setInterval(() => void runSync().catch(() => null), AUTOSYNC_INTERVAL_MS);
      timer.unref();
    }
  };

  // Kick the rule blocks on boot when autoSync is on.
  if (config.autoSync) {
    void applyAutoSync(true);
  }

  app.get('/config', (c) =>
    c.json({
      rootPath: store.root,
      defaultRoot: defaultMemoryRoot(),
      autoSync: config.autoSync,
    }),
  );

  app.put('/config', async (c) => {
    const body = await c.req.json<{ rootPath?: string; autoSync?: boolean }>();
    const next: HubConfig = { autoSync: body.autoSync ?? config.autoSync };
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
    config = next;
    writeHubConfig(config);
    if (rootChanged) {
      store = new MemoryStore(db, config.memoryRoot!);
      await store.reindex();
    }
    if (syncChanged || rootChanged) {
      await applyAutoSync(config.autoSync);
    }
    return c.json({ rootPath: store.root, autoSync: config.autoSync });
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
      return c.json(await enrollAgent(body.agent, defaultMemoryRoot()));
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
