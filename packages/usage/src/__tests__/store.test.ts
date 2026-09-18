import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Real schema, not a hand-rolled copy: a migration that forgot a column then
// shows up here instead of only in production.
import { insertRecords, migrate, openDb, queryByProject, queryDaily, queryHourly, querySummary } from '../store.js';
import type { UsageRecord } from '../types.js';

function recordAt(ts: string, tokens: number, agent = 'codex'): UsageRecord {
  return {
    agent,
    sessionId: 's1',
    model: 'gpt-5.5',
    timestamp: ts,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    estimated: false,
    dedupeKey: `test:${agent}:${ts}`,
  };
}

function localIso(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

describe('calendar-day query semantics', () => {
  it('days=1 counts only records since local midnight', () => {
    const db = openDb(':memory:');
    insertRecords(db, [
      recordAt(localIso(1, 23, 55), 1000), // yesterday 23:55 local
      recordAt(localIso(0, 0, 5), 500),   // today 00:05 local
      recordAt(localIso(0, 9, 0), 300),   // today 09:00 local
    ], ':memory:');
    const today = querySummary(db, 1);
    expect(today.calls).toBe(2);
    expect(today.inputTokens).toBe(800);
    const all = querySummary(db);
    expect(all.calls).toBe(3);
    db.close();
  });

  it('days=7 spans the last 7 calendar days including today', () => {
    const db = openDb(':memory:');
    insertRecords(db, [
      recordAt(localIso(6, 10, 0), 100),  // 6 days ago → inside
      recordAt(localIso(7, 23, 0), 200),  // 7 days ago → outside
      recordAt(localIso(0, 8, 0), 400),   // today → inside
    ], ':memory:');
    const week = querySummary(db, 7);
    expect(week.calls).toBe(2);
    expect(week.inputTokens).toBe(500);
    db.close();
  });

  it('queryHourly buckets today by local hour and ignores yesterday', () => {
    const db = openDb(':memory:');
    insertRecords(db, [
      recordAt(localIso(0, 8, 15), 100),   // today 08:15 → hour 08
      recordAt(localIso(0, 8, 45), 200),   // today 08:45 → hour 08
      recordAt(localIso(0, 13, 5), 300),   // today 13:05 → hour 13
      recordAt(localIso(1, 23, 50), 400),  // yesterday → excluded
    ], ':memory:');
    const rows = queryHourly(db);
    const h08 = rows.find((r) => r.hour === '08');
    const h13 = rows.find((r) => r.hour === '13');
    expect(h08?.inputTokens).toBe(300);
    expect(h13?.inputTokens).toBe(300);
    expect(rows.some((r) => r.hour === '23')).toBe(false);
    db.close();
  });

  it('queryDaily buckets by local day, not UTC day', () => {
    const db = openDb(':memory:');
    // 01:30 UTC = 09:30 Beijing (next local day on a +8 box); must bucket locally.
    const utc = new Date();
    utc.setUTCHours(1, 30, 0, 0);
    insertRecords(db, [recordAt(utc.toISOString(), 42)], ':memory:');
    const rows = queryDaily(db, 0);
    const localDay = (() => { const d = new Date(utc); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    expect(rows.length).toBe(1);
    expect(rows[0]!.day).toBe(localDay);
    db.close();
  });
});

describe('project grouping', () => {
  function recordFor(over: Partial<UsageRecord>): UsageRecord {
    return { ...recordAt(new Date().toISOString(), 100), ...over } as UsageRecord;
  }

  it('merges the two slug spellings of one directory once the path is known', () => {
    const db = openDb(':memory:');
    // Claude Code kept the leading separator, the others stripped it — the
    // same directory used to show up as two rows.
    insertRecords(db, [
      recordFor({
        dedupeKey: 'a',
        project: '-Users-demo-Code-agora',
        projectPath: '/Users/demo/Code/agora',
        agent: 'claude-code',
      }),
      recordFor({
        dedupeKey: 'b',
        project: 'Users-demo-Code-agora',
        projectPath: '/Users/demo/Code/agora',
        agent: 'codex',
      }),
    ], ':memory:');
    const rows = queryByProject(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project).toBe('/Users/demo/Code/agora');
    expect(rows[0]!.projectPath).toBe('/Users/demo/Code/agora');
    expect(rows[0]!.inputTokens).toBe(200);
    db.close();
  });

  it('keeps showing legacy rows that have no path yet', () => {
    const db = openDb(':memory:');
    insertRecords(db, [recordFor({ dedupeKey: 'c', project: 'Users-demo-Code-old' })], ':memory:');
    const rows = queryByProject(db);
    expect(rows[0]!.project).toBe('Users-demo-Code-old');
    expect(rows[0]!.projectPath).toBeNull();
    db.close();
  });

  it('adds project_path to a database created before the column existed', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`CREATE TABLE usage_records (
      dedupe_key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      project TEXT, model TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
      source_path TEXT NOT NULL, collected_at TEXT NOT NULL DEFAULT '')`);
    legacy.exec(
      `INSERT INTO usage_records (dedupe_key, agent, session_id, project, model, ts, input_tokens, source_path)
       VALUES ('old', 'codex', 's1', 'Users-demo-Code-old', 'gpt-5.5', '${new Date().toISOString()}', 42, 'x')`,
    );
    migrate(legacy);
    expect(queryByProject(legacy)[0]).toMatchObject({ project: 'Users-demo-Code-old', inputTokens: 42 });
    insertRecords(legacy, [recordFor({ dedupeKey: 'new', projectPath: '/Users/demo/Code/new' })], ':memory:');
    expect(queryByProject(legacy).map((r) => r.project)).toContain('/Users/demo/Code/new');
    legacy.close();
  });
});
