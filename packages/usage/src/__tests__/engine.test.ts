import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCollection } from '../engine.js';
import { insertRecords, openDb, queryByAgent, queryCollectorStatus, querySummary } from '../store.js';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '../../fixtures');

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-engine-test-'));
  db = openDb(join(dir, 'agora.db'));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixtureEnv() {
  // RunOptions.env is a CollectorEnv, whose `env` field carries the ProcessEnv overrides.
  return {
    env: {
      env: {
        CLAUDE_CONFIG_DIRS: join(fixtures, 'claude'),
        CODEX_HOME: join(fixtures, 'codex'),
        OPENCODE_DATA_DIR: join(fixtures, 'opencode-empty'),
      },
    },
  };
}

describe('collection engine', () => {
  it('collects from all collectors and stores records', { timeout: 60000 }, async () => {
    const report = await runCollection(db, fixtureEnv());
    expect(report.totals.failed).toBe(0);
    expect(report.totals.inserted).toBeGreaterThan(0);

    const summary = querySummary(db);
    expect(summary.calls).toBe(report.totals.inserted);
    expect(summary.costUSD).toBeGreaterThan(0);

    const agents = queryByAgent(db).map((a) => a.agent);
    expect(agents).toContain('claude-code');
    expect(agents).toContain('codex');
  });

  it('second run skips unchanged sources (fingerprint)', { timeout: 60000 }, async () => {
    const report = await runCollection(db, fixtureEnv());
    expect(report.sources.every((s) => s.status === 'unchanged')).toBe(true);
    expect(report.totals.inserted).toBe(0);
  });

  it('forced re-parse is idempotent (dedupe keys prevent double counting)', { timeout: 60000 }, async () => {
    const before = querySummary(db);
    const report = await runCollection(db, { ...fixtureEnv(), force: true });
    expect(report.totals.parsed).toBeGreaterThan(0);
    expect(report.totals.inserted).toBe(0); // all duplicates
    expect(report.totals.duplicates).toBe(report.totals.parsed);
    const after = querySummary(db);
    expect(after.calls).toBe(before.calls);
    expect(after.costUSD).toBe(before.costUSD);
  });

  it('tracks collector state per source', async () => {
    const status = queryCollectorStatus(db);
    expect(status.length).toBeGreaterThan(0);
    for (const s of status) expect(s.recordCount).toBeGreaterThanOrEqual(0);
  });
});

it('detects live SQLite WAL changes without a main database change', async () => {
  const { fingerprint, sameFingerprint } = await import('../collectors/shared.js');
  const path = join(dir, 'wal.db');
  const writer = new Database(path);
  try {
    writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE test (value INTEGER)');
    const before = await fingerprint(path, true);
    writer.exec('INSERT INTO test VALUES (1)');
    const after = await fingerprint(path, true);
    expect(before!.sizeBytes).toBe(after!.sizeBytes);
    expect(sameFingerprint(before, after)).toBe(false);
  } finally { writer.close(); }
});
it('refreshes existing keys from another source without deleting omitted history', () => {
  const isolated = openDb(join(dir,'refresh.db'));
  const record = {dedupeKey:'stable',agent:'codex' as const,sessionId:'s',model:'old',timestamp:'2026-09-15T00:00:00Z',inputTokens:1,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0,webSearchRequests:0,costUSD:1,estimated:false};
  try {
    insertRecords(isolated,[record,{...record,dedupeKey:'omitted'}],'old-path');
    insertRecords(isolated,[{...record,model:'correct',costUSD:2}],'new-path',true);
    expect(querySummary(isolated).calls).toBe(2);
    expect(querySummary(isolated).costUSD).toBe(3);
    expect(isolated.prepare('SELECT model FROM usage_records WHERE dedupe_key=?').get('stable')).toEqual({model:'correct'});
  } finally { isolated.close(); }
});
