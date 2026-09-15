import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { opencodeCollector } from '../collectors/opencode.js';
import type { UsageRecord } from '../types.js';

let dir: string;
let dbPath: string;

function buildFixtureDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      time_archived INTEGER,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      tokens_cache_write INTEGER,
      model TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      data TEXT
    );
  `);

  const insSession = db.prepare(
    'INSERT INTO session (id, parent_id, time_archived, directory, title, time_created, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)');
  const insPart = db.prepare('INSERT INTO part (id, session_id, message_id, data) VALUES (?,?,?,?)');

  const t0 = 1788747246000; // ms epoch
  // Active top-level session with one assistant + one user + one empty assistant message
  insSession.run('ses_active', null, null, '/Users/demo/proj-oc', null, t0, null, null, null, null, null, null, null);
  insMessage.run('m_user', 'ses_active', t0, JSON.stringify({ role: 'user' }));
  insPart.run('p_user', 'ses_active', 'm_user', JSON.stringify({ type: 'text', text: 'hi' }));
  insMessage.run(
    'm_asst',
    'ses_active',
    t0 + 1000,
    JSON.stringify({
      role: 'assistant',
      modelID: 'claude-sonnet-4-5',
      cost: 0,
      tokens: { input: 500, output: 120, reasoning: 30, cache: { read: 40, write: 10 } },
    }),
  );
  insPart.run('p_tool', 'ses_active', 'm_asst', JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }));
  insMessage.run('m_empty', 'ses_active', t0 + 2000, JSON.stringify({ role: 'assistant', tokens: { input: 0, output: 0 } }));

  // Archived top-level session (usage hub must still count it) with native cost only
  insSession.run('ses_archived', null, t0 + 3000, '/Users/demo/proj-oc2', null, t0, null, null, null, null, null, null, null);
  insMessage.run(
    'm_arch',
    'ses_archived',
    t0 + 3000,
    JSON.stringify({
      role: 'assistant',
      modelID: 'internal/unpriced-model-xyz',
      cost: 1.25,
      tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );
  insPart.run('p_arch', 'ses_archived', 'm_arch', JSON.stringify({ type: 'text', text: 'answer' }));

  // Crash-only session: no message-level tokens, session row carries the rollup
  insSession.run(
    'ses_rollup', null, null, '/Users/demo/proj-oc3', null, t0 + 4000,
    0.5, 800, 60, 12, 5, 3, JSON.stringify({ id: 'claude-haiku-4-5', providerID: 'anthropic' }),
  );
  insMessage.run('m_rollup_user', 'ses_rollup', t0 + 4000, JSON.stringify({ role: 'user' }));

  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-opencode-fixture-'));
  dbPath = join(dir, 'opencode.db');
  buildFixtureDb(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function collect(): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of opencodeCollector.parse({ kind: 'sqlite', path: dbPath, agent: 'opencode' })) out.push(r);
  return out;
}

describe('opencode collector', () => {
  it('discovers opencode*.db in the data dir', async () => {
    const sources = await opencodeCollector.discover({ env: { OPENCODE_DATA_DIR: dir } });
    expect(sources.length).toBe(1);
    expect(sources[0]!.path).toBe(dbPath);
  });

  it('parses assistant messages with token detail', async () => {
    const records = await collect();
    const main = records.find((r) => r.dedupeKey === 'opencode:ses_active:m_asst')!;
    expect(main.inputTokens).toBe(500);
    expect(main.outputTokens).toBe(120);
    expect(main.reasoningTokens).toBe(30);
    expect(main.cacheReadTokens).toBe(40);
    expect(main.cacheWriteTokens).toBe(10);
    expect(main.project).toBe('Users-demo-proj-oc');
    expect(main.costUSD).toBeGreaterThan(0);
  });

  it('skips empty assistant turns', async () => {
    const records = await collect();
    expect(records.some((r) => r.dedupeKey === 'opencode:ses_active:m_empty')).toBe(false);
  });

  it('includes archived sessions and falls back to native cost', async () => {
    const records = await collect();
    const arch = records.find((r) => r.dedupeKey === 'opencode:ses_archived:m_arch');
    expect(arch).toBeDefined();
    // internal/unpriced-model-xyz has no pricing entry → native cost wins
    expect(arch!.costUSD).toBe(1.25);
  });

  it('emits a session-level rollup record for crash-only sessions', async () => {
    const records = await collect();
    const roll = records.find((r) => r.dedupeKey === 'opencode:ses_rollup:session-level');
    expect(roll).toBeDefined();
    expect(roll!.inputTokens).toBe(800);
    expect(roll!.outputTokens).toBe(60);
    expect(roll!.reasoningTokens).toBe(12);
    expect(roll!.model).toBe('anthropic/claude-haiku-4-5');
    expect(roll!.costUSD).toBeGreaterThan(0);
  });
});
