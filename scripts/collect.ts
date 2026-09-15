/**
 * Dogfood smoke run: collect usage from this machine's real
 * Codex / OpenCode / Claude Code data and print a summary.
 * Usage: pnpm tsx scripts/collect.ts [--force] [--db <path>]
 */
import { openDb, queryByAgent, querySummary, runCollection } from '../packages/usage/src/index.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

const db = openDb(dbPath);
const report = await runCollection(db, { force });

console.log('\n=== Collection report ===');
for (const s of report.sources) {
  const tag = s.status === 'collected' ? `+${s.inserted}` : s.status === 'failed' ? `FAIL: ${s.error}` : '—';
  console.log(`[${s.agent}] ${s.status.padEnd(9)} ${tag}  ${s.sourcePath}`);
}
console.log(
  `\nTotals: parsed=${report.totals.parsed} inserted=${report.totals.inserted} ` +
    `duplicates=${report.totals.duplicates} failed=${report.totals.failed}`,
);

console.log('\n=== Summary (all time) ===');
console.log(querySummary(db));
console.log('\n=== By agent ===');
console.table(queryByAgent(db));
