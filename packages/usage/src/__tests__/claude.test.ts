import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { claudeCollector } from '../collectors/claude.js';
import type { UsageRecord } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures');

async function collect(sourcePath: string, project?: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  const source = { kind: 'jsonl' as const, path: sourcePath, agent: 'claude-code', ...(project ? { project } : {}) };
  for await (const r of claudeCollector.parse(source)) out.push(r);
  return out;
}

describe('claude collector', () => {
  const jsonl = join(fixtures, 'claude/projects/-Users-demo-project-a/sess-1.jsonl');

  it('discovers jsonl files under projects/', async () => {
    const sources = await claudeCollector.discover({ env: { CLAUDE_CONFIG_DIRS: join(fixtures, 'claude') } });
    expect(sources.length).toBe(1);
    expect(sources[0]!.path).toBe(jsonl);
    expect(sources[0]!.project).toBe('-Users-demo-project-a');
  });

  it('parses assistant entries, skips non-usage rows', async () => {
    const records = await collect(jsonl);
    // msg_001 (deduped), msg_002, msg_003 kept; system + empty assistant + usage-less skipped
    expect(records.map((r) => r.dedupeKey)).toEqual([
      'claude-code:msg_001',
      'claude-code:msg_002',
      'claude-code:msg_003',
    ]);
  });

  it('dedupes streaming restatements: last wins, first timestamp kept', async () => {
    const records = await collect(jsonl);
    const msg1 = records.find((r) => r.dedupeKey === 'claude-code:msg_001')!;
    expect(msg1.outputTokens).toBe(35); // LAST restatement's usage
    expect(msg1.timestamp).toBe('2026-09-01T10:00:05.000Z'); // FIRST occurrence's timestamp
  });

  it('extracts cache creation split (5m + 1h)', async () => {
    const records = await collect(jsonl);
    const msg2 = records.find((r) => r.dedupeKey === 'claude-code:msg_002')!;
    // split present: total = max(legacy 0, 60+20) = 80; oneHour = min(20, 80) = 20
    expect(msg2.cacheWriteTokens).toBe(80);
    expect(msg2.cacheReadTokens).toBe(30);
  });

  it('captures web search requests and computes positive cost', async () => {
    const records = await collect(jsonl);
    const msg3 = records.find((r) => r.dedupeKey === 'claude-code:msg_003')!;
    expect(msg3.webSearchRequests).toBe(2);
    expect(msg3.costUSD).toBeGreaterThan(0);
    for (const r of records) expect(r.costUSD).toBeGreaterThan(0);
  });

  it('carries session id and project slug', async () => {
    const records = await collect(jsonl, '-Users-demo-project-a');
    for (const r of records) {
      expect(r.sessionId).toBe('sess-claude-1');
      expect(r.project).toBe('-Users-demo-project-a');
    }
  });
});
