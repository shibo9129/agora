/**
 * Agora CLI: `agora collect` (run usage collection once) and `agora doctor`
 * (environment self-check). `agora` / `agora start` / `agora mcp` are routed
 * by bin/agora.js to the server / MCP bundles instead.
 */
import { detectAgents } from '@agora/adapters';
import { openDb, queryByAgent, runCollection } from '@agora/usage';

const command = process.argv[2];

if (command === 'collect') {
  const force = process.argv.includes('--force');
  const db = openDb();
  const report = await runCollection(db, { force });
  console.log(`采集完成：新增 ${report.totals.inserted} · 重复 ${report.totals.duplicates} · 失败 ${report.totals.failed}`);
  console.table(queryByAgent(db).map((a) => ({ agent: a.agent, cost: `$${a.costUSD.toFixed(2)}`, tokens: a.totalTokens, calls: a.calls })));
} else if (command === 'doctor') {
  const agents = await detectAgents();
  console.log('Agent 探测：');
  for (const a of agents) {
    console.log(`  ${a.installed ? '✓' : '✗'} ${a.displayName.padEnd(18)} ${a.configHome}${a.detail ? `  (${a.detail})` : ''}`);
  }
  const db = openDb();
  const rows = queryByAgent(db);
  console.log(`\n用量库：${rows.reduce((s, r) => s + r.calls, 0)} 条记录，覆盖 ${rows.length} 个 agent`);
} else {
  console.log(`用法：
  agora            启动本地中枢（127.0.0.1:7878）
  agora mcp        以 stdio 运行 MCP server（供 Agent 接入）
  agora collect    立即采集一次各 Agent 的 token 用量
  agora doctor     环境自检（Agent 探测 + 数据摘要）`);
}
