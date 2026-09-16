/**
 * Agora server — localhost-only AI hub.
 *
 * Bind policy: 127.0.0.1 by default, always. LAN/server mode is a planned
 * extension behind explicit config + auth, never implicit.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectAgents } from '@agora/adapters';
import { migrateKnowledge } from '@agora/knowledge';
import {
  openDb,
  queryByAgent,
  queryByModel,
  queryByProject,
  queryCollectorStatus,
  queryDaily,
  queryHourly,
  querySummary,
  runCollection,
  type CollectionReport,
} from '@agora/usage';

import { localBoundary } from './security.js';
import { kbRoutes } from './kb.js';
import { memoryRoutes, hubRoutes } from './memory.js';
import { ratesRoutes } from './rates.js';
import { toolRoutes } from './tools.js';
import { emitHubEvent, hubEvents, startRealtimeWatch, type HubEvent } from './watch.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env['AGORA_PORT'] ?? 7878);
const host = process.env['AGORA_HOST'] ?? '127.0.0.1';

if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Agora 当前仅支持本地监听；远程服务模式尚未启用');
const devOrigin = process.env['AGORA_DEV_ORIGIN'];
if (devOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(devOrigin)) throw new Error('开发来源必须为本地 HTTP 地址');

const db = openDb(process.env['AGORA_DB']);
migrateKnowledge(db);
const app = new Hono();

// The UI talks to the same origin in production; CORS only for vite dev.
app.use('*', localBoundary(port, devOrigin));
if (devOrigin) app.use('/api/*', cors({ origin: devOrigin, allowHeaders: ['Content-Type', 'X-Agora-Request'] }));

app.get('/api/health', (c) => c.json({ ok: true, name: 'agora', version: '0.1.1' }));

// ── Agents ────────────────────────────────────────────────────────────────
app.get('/api/agents', async (c) => {
  const agents = (await detectAgents()).filter((a) => a.kind !== 'virtual');
  return c.json({ agents });
});

// ── Usage collection ──────────────────────────────────────────────────────
let collecting: Promise<CollectionReport> | null = null;

app.post('/api/collect', async (c) => {
  if (!collecting) {
    const force = c.req.query('force') === '1';
    collecting = runCollection(db, { force }).finally(() => {
      collecting = null;
    });
  }
  const report = await collecting;
  return c.json(report);
});

// Auto-collect on start: the app should have data the moment the user first
// opens it (desktop is the primary distribution — no manual setup step).
// Disable with AGORA_NO_AUTOCOLLECT=1. Runs in the background, never blocks.
const startCollection = (): Promise<CollectionReport> => {
  if (!collecting) {
    collecting = runCollection(db, {}).finally(() => {
      collecting = null;
    });
  }
  return collecting;
};

if (process.env['AGORA_NO_AUTOCOLLECT'] !== '1') {
  setImmediate(() => {
    void startCollection().then((report) => {
      console.log(
        `[agora] 启动自动采集完成：新增 ${report.totals.inserted} 条（解析 ${report.totals.parsed}，重复 ${report.totals.duplicates}）`,
      );
      emitHubEvent('usage-updated', { inserted: report.totals.inserted, parsed: report.totals.parsed });
    }).catch((err) => console.error('[agora] 启动自动采集失败:', err));
  });
}

// ── Real-time pipeline: watch agent data dirs → incremental collect → SSE ──
startRealtimeWatch({ collect: () => startCollection() });

// ── SSE: every open UI subscribes here and updates live ───────────────────
app.get('/api/events', (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'hello', data: '{"ok":true}' });
    const listener = (event: HubEvent) => {
      void stream
        .writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => {
          hubEvents.off('hub-event', listener);
        });
    };
    hubEvents.on('hub-event', listener);
    const keepalive = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
        clearInterval(keepalive);
        hubEvents.off('hub-event', listener);
      });
    }, 25_000);
    stream.onAbort(() => {
      clearInterval(keepalive);
      hubEvents.off('hub-event', listener);
    });
    await new Promise(() => {});
  });
});

// ── Agent re-detection: newly installed agents get auto-enrolled + broadcast ──
const AGENT_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
let knownAgentIds = new Set<string>((await detectAgents()).filter((a) => a.installed).map((a) => a.id));
setInterval(async () => {
  try {
    const now = (await detectAgents()).filter((a) => a.installed).map((a) => a.id);
    const added = now.filter((id) => !knownAgentIds.has(id));
    if (added.length > 0) {
      knownAgentIds = new Set(now);
      emitHubEvent('agents-updated', { added });
    }
  } catch {
    // detection failure — skip this round quietly
  }
}, AGENT_RECHECK_INTERVAL_MS).unref();

app.get('/api/collectors/status', (c) => c.json({ sources: queryCollectorStatus(db) }));

// ── Usage queries ─────────────────────────────────────────────────────────
function daysParam(c: { req: { query: (k: string) => string | undefined } }): number | undefined {
  const raw = c.req.query('days');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

app.get('/api/usage/summary', (c) => c.json(querySummary(db, daysParam(c))));
app.get('/api/usage/by-agent', (c) => c.json({ rows: queryByAgent(db, daysParam(c)) }));
app.get('/api/usage/by-model', (c) => c.json({ rows: queryByModel(db, daysParam(c)) }));
app.get('/api/usage/by-project', (c) => c.json({ rows: queryByProject(db, daysParam(c)) }));
app.get('/api/usage/daily', (c) => c.json({ rows: queryDaily(db, daysParam(c) ?? 30) }));
app.get('/api/usage/hourly', (c) => c.json({ rows: queryHourly(db) }));

// ── Knowledge bases ───────────────────────────────────────────────────────
app.route('/api/kb', kbRoutes(db));

// ── Tool center (skills / MCP / health) ───────────────────────────────────
app.route('/api/tools', toolRoutes());

// ── Memory + hub enrollment ───────────────────────────────────────────────
app.route('/api/memory', memoryRoutes(db));
app.route('/api/hub', hubRoutes());
app.route('/api/rates', ratesRoutes());

// ── Static web bundle (production build of apps/web) ─────────────────────
// Layouts: bundled package → dist/web; dev checkout → apps/web/dist.
const webDistCandidates = [
  process.env['AGORA_WEB_DIST'],
  join(here, 'web'),
  join(here, '../../web/dist'),
].filter((p): p is string => typeof p === 'string');
const webDist = webDistCandidates.find((p) => existsSync(p));
if (webDist) {
  app.use('/*', serveStatic({ root: webDist }));
  // SPA fallback
  app.get('*', serveStatic({ path: join(webDist, 'index.html') }));
}

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`agora server listening on http://${host}:${info.port}`);
});

// Orphan watchdog: when launched as a desktop-app sidecar, exit promptly if
// our parent process dies (prevents leaked sidecars from crashed apps).
if (process.env['AGORA_NO_ORPHAN_WATCHDOG'] !== '1') {
  const parentPid = process.ppid;
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log('[agora] 父进程已退出，sidecar 自动退出');
      process.exit(0);
    }
  }, 5000).unref();
}
