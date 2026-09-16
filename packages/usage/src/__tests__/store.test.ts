import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { insertRecords, queryDaily, querySummary } from '../store.js';
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
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE usage_records (
      dedupe_key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      project TEXT, model TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
      source_path TEXT NOT NULL, collected_at TEXT NOT NULL DEFAULT '')`);
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
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE usage_records (
      dedupe_key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      project TEXT, model TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
      source_path TEXT NOT NULL, collected_at TEXT NOT NULL DEFAULT '')`);
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

  it('queryDaily buckets by local day, not UTC day', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE usage_records (
      dedupe_key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      project TEXT, model TEXT NOT NULL, ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0,
      source_path TEXT NOT NULL, collected_at TEXT NOT NULL DEFAULT '')`);
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
