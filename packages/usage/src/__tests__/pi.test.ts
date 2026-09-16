import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { piCollector } from '../collectors/pi.js';
import type { UsageRecord } from '../types.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-pi-fixture-'));
  const sessionDir = join(root, '.pi/agent/sessions/--Users-demo-agora--');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, '2026-09-15T04-00-00-000Z_abc123.jsonl'),
    [
      '{"type":"session","version":3,"id":"abc123","timestamp":"2026-09-15T04:00:00.000Z","cwd":"/Users/demo/agora"}',
      '{"type":"model_change","id":"m1","timestamp":"2026-09-15T04:00:01.000Z","provider":"demo-coding","modelId":"demo-unpriced-model"}',
      '{"type":"message","id":"u1","timestamp":"2026-09-15T04:00:02.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"message","id":"a1","timestamp":"2026-09-15T04:00:05.000Z","message":{"role":"assistant","model":"demo-unpriced-model","content":[{"type":"text","text":"hello"}],"usage":{"input":1000,"output":100,"cacheRead":500,"cacheWrite":20,"totalTokens":1620,"cost":{"total":0.05}}}}',
      '{"type":"message","id":"a2","timestamp":"2026-09-15T04:00:10.000Z","message":{"role":"assistant","model":"demo-unpriced-model","content":[{"type":"text","text":"more"}],"usage":{"input":2000,"output":200,"cacheRead":1500,"cacheWrite":0,"totalTokens":3700,"cost":{"total":0.07}}}}',
      '{"type":"message","id":"a3","timestamp":"2026-09-15T04:00:12.000Z","message":{"role":"assistant","content":[]}}',
    ].join('\n') + '\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function collect(sourcePath: string): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of piCollector.parse({ kind: 'jsonl', path: sourcePath, agent: 'pi' })) out.push(r);
  return out;
}

describe('pi collector', () => {
  const jsonl = () => join(root, '.pi/agent/sessions/--Users-demo-agora--/2026-09-15T04-00-00-000Z_abc123.jsonl');

  it('discovers session jsonl files under PI_HOME', async () => {
    const sources = await piCollector.discover({ home: root, env: {} });
    expect(sources.length).toBe(1);
    expect(sources[0]!.path).toBe(jsonl());
  });

  it('parses assistant usage rows only', async () => {
    const records = await collect(jsonl());
    expect(records.length).toBe(2); // a1 + a2; user and empty assistant skipped
    expect(records[0]!.dedupeKey).toBe('pi:abc123:a1');
    expect(records[1]!.dedupeKey).toBe('pi:abc123:a2');
  });

  it('tracks model from model_change and session cwd as project', async () => {
    const records = await collect(jsonl());
    expect(records[0]!.model).toBe('demo-unpriced-model');
    expect(records[0]!.project).toBe('Users-demo-agora');
    expect(records[0]!.sessionId).toBe('abc123');
  });

  it('extracts token buckets', async () => {
    const records = await collect(jsonl());
    expect(records[0]!.inputTokens).toBe(1000);
    expect(records[0]!.outputTokens).toBe(100);
    expect(records[0]!.cacheReadTokens).toBe(500);
    expect(records[0]!.cacheWriteTokens).toBe(20);
    expect(records[1]!.cacheWriteTokens).toBe(0);
  });

  it('uses native cost as fallback for unpriced models', async () => {
    const records = await collect(jsonl());
    // k3 is not in the bundled pricing table → native cost wins
    expect(records[0]!.costUSD).toBe(0.05);
    expect(records[1]!.costUSD).toBe(0.07);
  });
});
