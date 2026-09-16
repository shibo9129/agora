/**
 * Agora server — localhost-only AI hub.
 *
 * Bind policy: 127.0.0.1 by default, always. LAN/server mode is a planned
 * extension behind explicit config + auth, never implicit.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
