import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hermesCollector } from '../collectors/hermes.js';
import type { UsageRecord } from '../types.js';

let dir: string;
let dbPath: string;

function buildFixtureDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      started_at REAL,
      last_activity_at REAL,
      cwd TEXT
    );
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '',
      billing_mode TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      cost_status TEXT,
      cost_source TEXT,
      first_seen REAL,
      last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
    );
  `);

  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, cwd) VALUES (?, ?, ?, ?, ?)`,
  ).run('ses_main', 'desktop', 'k3-256k', 1788747245, '/Users/demo/proj-hermes');
  db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, task, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ses_main', 'k3-256k', '', 12, 100000, 5000, 900000, 0, 800, 1788747245, 1788747305);

  // Zero-usage row must be skipped
  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, cwd) VALUES (?, ?, ?, ?, ?)`,
  ).run('ses_empty', 'cron', 'k2.7-code', 1788747400, null);
  db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, task, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ses_empty', 'k2.7-code', '', 0, 0, 0, 0, 0, 0, 1788747400, 1788747400);

  // Unpriced model with native cost → native cost wins
  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, cwd) VALUES (?, ?, ?, ?, ?)`,
  ).run('ses_native', 'cron', 'internal-xyz', 1788747500, null);
  db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, task, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ses_native', 'internal-xyz', 'heartbeat', 1, 500, 50, 0, 0, 0, 0.75, 0, 1788747500, 1788747505);

  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-hermes-fixture-'));
  dbPath = join(dir, 'state.db');
  buildFixtureDb(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function collect(): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of hermesCollector.parse({ kind: 'sqlite', path: dbPath, agent: 'hermes' })) out.push(r);
  return out;
}

describe('hermes collector', () => {
  it('discovers state.db under HERMES_HOME', async () => {
    const sources = await hermesCollector.discover({ env: { HERMES_HOME: dir } });
    expect(sources.length).toBe(1);
    expect(sources[0]!.path).toBe(dbPath);
  });

  it('returns nothing when state.db is missing', async () => {
    const sources = await hermesCollector.discover({ env: { HERMES_HOME: join(dir, 'nope') } });
    expect(sources.length).toBe(0);
  });

  it('parses session_model_usage rows with token detail and k3 pricing', async () => {
    const records = await collect();
    const main = records.find((r) => r.dedupeKey === 'hermes:ses_main:k3-256k:')!;
    expect(main.inputTokens).toBe(100000);
    expect(main.outputTokens).toBe(5000);
    expect(main.cacheReadTokens).toBe(900000);
    expect(main.reasoningTokens).toBe(800);
    expect(main.project).toBe('Users-demo-proj-hermes');
    expect(main.timestamp).toBe(parseTimestampExpect(1788747305));
    // k3-256k aliases to kimi-k3 → priced
    expect(main.costUSD).toBeGreaterThan(0);
  });

  it('skips zero-usage rows', async () => {
    const records = await collect();
    expect(records.some((r) => r.sessionId === 'ses_empty')).toBe(false);
  });

  it('falls back to native cost for unpriced models', async () => {
    const records = await collect();
    const native = records.find((r) => r.dedupeKey === 'hermes:ses_native:internal-xyz:heartbeat');
    expect(native).toBeDefined();
    expect(native!.costUSD).toBe(0.75);
  });
});

function parseTimestampExpect(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}
