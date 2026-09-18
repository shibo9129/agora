/**
 * Agora system test: functional + performance + security, one report.
 * Requires a running server on 127.0.0.1:7878.
 * Run: ../../node_modules/.bin/tsx scripts/system-test.ts (from apps/server)
 */
import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';

const BASE = 'http://127.0.0.1:7878';
const W = { headers: { 'X-Agora-Request': '1', 'Content-Type': 'application/json' } };

/** Raw HTTP request (undici fetch silently drops forbidden headers like Host). */
function rawRequest(options: { host: string; port: number; path: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function getJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: performance.now() - t0 };
}

// ── 1. Functional ──────────────────────────────────────────────────────────
console.log('\n== 功能测试 ==');
{
  const health = await getJson('/api/health');
  check('health 200', health.status === 200 && (health.body as { ok?: boolean }).ok === true);

  const agents = await getJson('/api/agents');
  const agentList = (agents.body as { agents?: { presence?: string; kind?: string }[] }).agents ?? [];
  check('agents 返回且不含虚拟位置', agents.status === 200 && agentList.every((a) => a.kind !== 'virtual'));
  check('agents 携带 presence 判定', agentList.every((a) => a.presence === 'installed' || a.presence === 'residual' || a.presence === 'absent'));

  const summary = await getJson('/api/usage/summary?days=1');
  check('usage summary(days=1) 形状正确', summary.status === 200 && typeof (summary.body as { totalTokens?: number }).totalTokens === 'number');

  const daily = await getJson('/api/usage/daily?days=7');
  check('usage daily 返回数组', daily.status === 200 && Array.isArray((daily.body as { rows?: unknown[] }).rows));

  const kbs = await getJson('/api/kb');
  const kbList = (kbs.body as { kbs?: { id: string }[] }).kbs ?? [];
  check('kb 列表返回', kbs.status === 200 && kbList.length >= 1);

  if (kbList[0]) {
    const tm = await getJson(`/api/kb/${kbList[0].id}/treemap?depth=2`);
    check('kb treemap 返回节点', tm.status === 200 && typeof (tm.body as { size?: number }).size === 'number');
    const search = await getJson(`/api/kb/${kbList[0].id}/search?q=Wiki`);
    check('kb 搜索返回', search.status === 200 && Array.isArray((search.body as { hits?: unknown[] }).hits));
  }

  const skills = await getJson('/api/tools/skills');
  check('skills 统一视图返回', skills.status === 200 && ((skills.body as { skills?: unknown[] }).skills?.length ?? 0) > 0);

  const mcps = await getJson('/api/tools/mcp');
  check('mcp 统一视图返回', mcps.status === 200 && Array.isArray((mcps.body as { servers?: unknown[] }).servers));

  const healthIssues = await getJson('/api/tools/health');
  check('健康检查返回', healthIssues.status === 200 && Array.isArray((healthIssues.body as { issues?: unknown[] }).issues));

  const memCfg = await getJson('/api/memory/config');
  check('memory config 返回', memCfg.status === 200 && typeof (memCfg.body as { rootPath?: string }).rootPath === 'string');

  const memSearch = await getJson('/api/memory/search?q=%E8%AE%B0%E5%BF%86');
  check('memory 搜索返回', memSearch.status === 200 && Array.isArray((memSearch.body as { hits?: unknown[] }).hits));

  const hubStatus = await getJson('/api/hub/status');
  check('hub status 返回', hubStatus.status === 200 && Array.isArray((hubStatus.body as { agents?: unknown[] }).agents));

  const rates = await getJson('/api/rates');
  const ratesBody = rates.body as { rates?: { CNY?: number }; source?: string };
  check('rates 返回且含 CNY', rates.status === 200 && typeof ratesBody.rates?.CNY === 'number');
  check('rates 来源标记', rates.status === 200 && ['frankfurter', 'cache', 'fallback'].includes(ratesBody.source ?? ''));

  const settings = await getJson('/api/settings');
  check('settings 返回币种', settings.status === 200 && typeof (settings.body as { currency?: string }).currency === 'string');
}

// ── 2. Performance ─────────────────────────────────────────────────────────
console.log('\n== 性能测试 ==');
const perf: Record<string, number> = {};
{
  perf['GET /api/usage/summary'] = await timed(async () => void (await getJson('/api/usage/summary')));
  perf['GET /api/usage/by-model'] = await timed(async () => void (await getJson('/api/usage/by-model?days=30')));
  perf['GET /api/agents'] = await timed(async () => void (await getJson('/api/agents')));
  perf['GET /api/tools/skills'] = await timed(async () => void (await getJson('/api/tools/skills')));
  perf['GET /api/tools/mcp'] = await timed(async () => void (await getJson('/api/tools/mcp')));
  perf['GET /api/tools/health'] = await timed(async () => void (await getJson('/api/tools/health')));
  perf['GET /api/memory/search'] = await timed(async () => void (await getJson('/api/memory/search?q=%E5%90%8C%E6%AD%A5')));
  const kbs = await getJson('/api/kb');
  const kbId = (kbs.body as { kbs?: { id: string }[] }).kbs?.[0]?.id;
  if (kbId) {
    perf['GET /api/kb/:id/treemap(d=4)'] = await timed(async () => void (await getJson(`/api/kb/${kbId}/treemap?depth=4`)));
    perf['GET /api/kb/:id/search'] = await timed(async () => void (await getJson(`/api/kb/${kbId}/search?q=wiki`)));
  }
  perf['POST /api/collect (增量)'] = await timed(async () => void (await getJson('/api/collect', { method: 'POST', ...W })));

  let allFast = true;
  for (const [name, ms] of Object.entries(perf)) {
    // collect 是重型采集（数万条会话增量解析+入库），给独立预算并标注基线。
    const budget = name.includes('collect') ? 120_000 : name.includes('health') || name.includes('skills') ? 5_000 : 1_500;
    const ok = ms < budget;
    if (!ok) allFast = false;
    console.log(`  ${ok ? '✓' : '✗'} ${name}: ${ms.toFixed(0)}ms（预算 ${budget}ms）`);
    if (!ok) failures.push(`性能超预算: ${name} ${ms.toFixed(0)}ms > ${budget}ms`);
  }
  if (allFast) passed++;
  const proc = await getJson('/api/health');
  void proc;
}

// ── 3. Security ────────────────────────────────────────────────────────────
console.log('\n== 安全测试 ==');
{
  // DNS-rebinding: hostile Host header must be rejected (raw http — fetch
  // silently drops the Host header, which would make this test vacuous).
  const badHost = await rawRequest({ host: '127.0.0.1', port: 7878, path: '/api/health', headers: { Host: 'evil.example.com' } });
  check('恶意 Host 头被拒绝 (403)', badHost.status === 403);

  const badOrigin = await fetch(`${BASE}/api/agents`, { headers: { Origin: 'http://evil.example.com' } });
  check('恶意 Origin 被拒绝 (403)', badOrigin.status === 403);

  // Write without the explicit marker must be rejected.
  const noMarker = await fetch(`${BASE}/api/collect`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('缺少 X-Agora-Request 的写请求被拒绝 (403)', noMarker.status === 403);

  // Path traversal on kb open.
  const kbs = await getJson('/api/kb');
  const kbId = (kbs.body as { kbs?: { id: string }[] }).kbs?.[0]?.id;
  if (kbId) {
    const escape = await fetch(`${BASE}/api/kb/${kbId}/open`, {
      method: 'POST',
      ...W,
      body: JSON.stringify({ path: '../../..../etc' }),
    });
    check('kb open 路径逃逸被拒绝 (400)', escape.status === 400);
  }

  // MCP output redaction: no raw tokens leak into API payloads.
  const mcp = await getJson('/api/tools/mcp');
  const mcpText = JSON.stringify(mcp.body);
  check('MCP 输出无 SECRET 泄漏', !/SECRET|TOKEN123|eyJ[A-Za-z0-9_-]{20,}/.test(mcpText));

  // Memory path traversal.
  const memEscape = await fetch(`${BASE}/api/memory/entry?path=${encodeURIComponent('../../../etc/passwd')}`);
  check('memory 路径逃逸被拒绝', memEscape.status === 400 || memEscape.status === 404 || memEscape.status === 500);

  // JSON content-type enforcement on writes.
  const wrongType = await fetch(`${BASE}/api/collect`, {
    method: 'POST',
    headers: { 'X-Agora-Request': '1', 'Content-Type': 'text/plain' },
  });
  check('非 JSON 写请求被拒绝 (415/403)', wrongType.status === 415 || wrongType.status === 403);
}

console.log(`\n== 总结：${passed} 通过 · ${failed} 失败 ==`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
