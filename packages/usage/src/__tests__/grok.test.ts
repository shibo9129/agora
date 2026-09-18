import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grokCollector } from '../collectors/grok.js';
import type { UsageRecord } from '../types.js';

let root: string;

const CWD = '/Users/demo/Code/my project';
const ENCODED = encodeURIComponent(CWD);
const SESSION = '01a0b29d-cf92-7c23-97e9-a4b1aa639732';

function counters(over: Partial<Record<string, number | string>> = {}) {
  return {
    inputTokens: 100_000,
    outputTokens: 1_000,
    cachedReadTokens: 90_000,
    cacheCreationTokens: 5_000,
    reasoningTokens: 400,
    totalTokens: 101_000,
    modelCalls: 3,
    costUsdTicks: 12_000_000_000, // 10^10 ticks per USD → $1.20
    ...over,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-grok-fixture-'));
  const sessionDir = join(root, '.grok/sessions', ENCODED, SESSION);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'usage.json'),
    JSON.stringify({
      sessionId: SESSION,
      updatedAt: '2026-09-18T05:32:39.332122+00:00',
      session: {
        ...counters({ inputTokens: 200_000, outputTokens: 2_000, costUsdTicks: 24_000_000_000 }),
        primaryModelId: 'grok-4.6-build',
        modelUsage: { 'grok-4.6-build': counters({ inputTokens: 200_000, outputTokens: 2_000 }) },
      },
      turns: [
        {
          turnNumber: 1,
          endedAt: '2026-09-18T04:05:06.209280+00:00',
          ...counters(),
          primaryModelId: 'grok-4.6-build',
          modelUsage: { 'grok-4.6-build': counters() },
        },
        {
          turnNumber: 2,
          endedAt: '2026-09-18T05:32:39.332122+00:00',
          ...counters(),
          primaryModelId: 'grok-4.6-build',
          // No modelUsage table: falls back to the turn's primary model.
        },
      ],
    }),
  );

  // A session that has not produced a usage ledger yet.
  mkdirSync(join(root, '.grok/sessions', ENCODED, 'no-usage-yet'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function parse(path: string, project?: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of grokCollector.parse({
    kind: 'json',
    path,
    agent: 'grok',
    ...(project !== undefined ? { project } : {}),
  })) {
    out.push(r);
  }
  return out;
}

describe('grok collector', () => {
  it('discovers usage.json per session and decodes the cwd', async () => {
    const sources = await grokCollector.discover({ home: root });
    expect(sources).toHaveLength(2);
    const withLedger = sources.find((s) => s.path.includes(SESSION));
    expect(withLedger?.project).toBe(CWD);
    expect(withLedger?.kind).toBe('json');
  });

  it('honours GROK_HOME', async () => {
    const sources = await grokCollector.discover({ home: '/nonexistent', env: { GROK_HOME: join(root, '.grok') } });
    expect(sources.length).toBeGreaterThan(0);
  });

  it('yields nothing for a session with no usage.json', async () => {
    expect(await parse(join(root, '.grok/sessions', ENCODED, 'no-usage-yet', 'usage.json'))).toEqual([]);
  });

  it('emits one record per turn per model, never the session rollup', async () => {
    const records = await parse(join(root, '.grok/sessions', ENCODED, SESSION, 'usage.json'), CWD);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.dedupeKey)).toEqual([
      `grok:${SESSION}:turn:1:grok-4.6-build`,
      `grok:${SESSION}:turn:2:grok-4.6-build`,
    ]);
    // Turns are increments: their sum is the session total, so counting both
    // would double the bill.
    expect(records.reduce((s, r) => s + r.costUSD, 0)).toBeCloseTo(2.4, 10);
  });

  it('splits Grok totals into disjoint token buckets', async () => {
    const [first] = await parse(join(root, '.grok/sessions', ENCODED, SESSION, 'usage.json'), CWD);
    expect(first).toBeDefined();
    // inputTokens (100k) is the superset of cached reads (90k) + creation (5k).
    expect(first!.inputTokens).toBe(5_000);
    expect(first!.cacheReadTokens).toBe(90_000);
    expect(first!.cacheWriteTokens).toBe(5_000);
    expect(first!.outputTokens).toBe(1_000);
    expect(first!.reasoningTokens).toBe(400);
    const dashboardTotal =
      first!.inputTokens + first!.outputTokens + first!.cacheReadTokens + first!.cacheWriteTokens;
    expect(dashboardTotal).toBe(101_000); // matches Grok's own totalTokens
  });

  it('converts costUsdTicks at 10^10 ticks per USD and records the real cwd', async () => {
    const [first] = await parse(join(root, '.grok/sessions', ENCODED, SESSION, 'usage.json'), CWD);
    expect(first!.costUSD).toBeCloseTo(1.2, 10);
    expect(first!.projectPath).toBe(CWD);
    expect(first!.model).toBe('grok-4.6-build');
    expect(first!.timestamp).toBe('2026-09-18T04:05:06.209Z');
  });

  it('falls back to the pricing table when the ledger reports no cost', async () => {
    const dir = join(root, '.grok/sessions', ENCODED, 'no-cost');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({
        sessionId: 'no-cost',
        updatedAt: '2026-09-18T05:00:00Z',
        turns: [
          {
            turnNumber: 1,
            endedAt: '2026-09-18T05:00:00Z',
            modelUsage: { 'grok-4.6': { inputTokens: 1_000_000, outputTokens: 0, costUsdTicks: 0 } },
          },
        ],
      }),
    );
    const [rec] = await parse(join(dir, 'usage.json'));
    expect(rec!.costUSD).toBeGreaterThan(0);
  });
});
