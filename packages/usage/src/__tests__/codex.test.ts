import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { codexCollector } from '../collectors/codex.js';
import type { UsageRecord } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures');

async function collect(sourcePath: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of codexCollector.parse({ kind: 'jsonl', path: sourcePath, agent: 'codex' })) out.push(r);
  return out;
}

describe('codex collector', () => {
  const sess1 = join(fixtures, 'codex/sessions/2026/09/02/rollout-2026-09-02T09-00-00-codex-sess-1.jsonl');
  const fork = join(fixtures, 'codex/sessions/2026/09/03/rollout-2026-09-03T09-00-00-codex-sess-fork.jsonl');

  it('discovers dated rollout files', async () => {
    const sources = await codexCollector.discover({ env: { CODEX_HOME: join(fixtures, 'codex') } });
    expect(sources.map((s) => s.path).sort()).toEqual([sess1, fork].sort());
  });

  it('converts cumulative counters to deltas; duplicate cumulative events are dropped', async () => {
    const records = await collect(sess1);
    // 5 token events, one duplicate cumulative (5000) → 4 records
    expect(records.length).toBe(4);
  });

  it('splits cached tokens out of input (OpenAI semantics)', async () => {
    const records = await collect(sess1);
    // event 1: input 1000, cached 600 → billed input 400, cacheRead 600
    expect(records[0]!.inputTokens).toBe(400);
    expect(records[0]!.cacheReadTokens).toBe(600);
    expect(records[0]!.outputTokens).toBe(100);
    expect(records[0]!.reasoningTokens).toBe(40);
    // event 2: input 2000, cached 1500 → 500 / 1500
    expect(records[1]!.inputTokens).toBe(500);
    expect(records[1]!.cacheReadTokens).toBe(1500);
  });

  it('falls back to cumulative diff when last_token_usage is absent, baseline still advances', async () => {
    const records = await collect(sess1);
    // event 3 (no `last`): total diff input 4500-3000=1500, cached 3600-2100=1500 → billed 0
    expect(records[2]!.inputTokens).toBe(0);
    expect(records[2]!.cacheReadTokens).toBe(1500);
    expect(records[2]!.outputTokens).toBe(200);
    // event 4 after the diff: last says input 1000 cached 900 → billed 100
    expect(records[3]!.inputTokens).toBe(100);
    expect(records[3]!.cacheReadTokens).toBe(900);
  });

  it('namespaces dedup keys by fork parent and uses cumulative values', async () => {
    const records = await collect(sess1);
    expect(records[0]!.dedupeKey).toBe('codex:codex-sess-1:1100:1000:600:100:40');
  });

  it('skips fork-replay events before the 5s cutoff', async () => {
    const records = await collect(fork);
    // meta at 09:00:00 +5s cutoff → the 09:00:01 replay is skipped, 09:00:10 kept
    expect(records.length).toBe(1);
    expect(records[0]!.inputTokens).toBe(50); // 100 - 50
    expect(records[0]!.dedupeKey.startsWith('codex:codex-sess-grandparent:')).toBe(true);
    expect(records[0]!.sessionId).toBe('codex-sess-parent');
  });

  it('rejects files without a session_meta first line', async () => {
    const records = await collect(join(fixtures, 'claude/projects/-Users-demo-project-a/sess-1.jsonl'));
    expect(records.length).toBe(0);
  });
});

it('reads top-level turn contexts and payload.id, including model changes', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'codex-model-'));
  try {
    const items = [{ type: 'session_meta', payload: { id: 'real-session' } }];
    for (const [i, model] of ['gpt-5.5', 'gpt-6'].entries()) {
      items.push({ type: 'turn_context', payload: { model } } as never);
      items.push({ type: 'event_msg', timestamp: '2026-09-15T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 * (i + 1) }, last_token_usage: { input_tokens: 90, output_tokens: 10 } } } } as never);
    }
    const path = join(dir, 'rollout.jsonl');
    await writeFile(path, items.map(x => JSON.stringify(x)).join('\n'));
    const rows = await collect(path);
    expect(rows.map(r => r.model)).toEqual(['gpt-5.5', 'gpt-6']);
    expect(rows.every(r => r.sessionId === 'real-session')).toBe(true);
  } finally { await rm(dir, { recursive: true }); }
});
