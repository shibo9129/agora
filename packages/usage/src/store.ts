/**
 * Usage storage: SQLite schema + aggregation queries.
 * Single-writer; the DB lives at `$AGORA_HOME/agora.db` (default `~/.agora`).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FileFingerprint, UsageRecord } from './types.js';

export function defaultDbPath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'agora.db');
}

export function openDb(dbPath: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      dedupe_key TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT,
      model TEXT NOT NULL,
      ts TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_requests INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      source_path TEXT NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_agent_ts ON usage_records(agent, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_records(project);

    CREATE TABLE IF NOT EXISTS collector_state (
      source_path TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0,
      last_collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

export interface InsertResult {
  inserted: number;
  duplicates: number;
}

export function insertRecords(db: Database.Database, records: UsageRecord[], sourcePath: string, refresh = false): InsertResult {
  const stmt = db.prepare(`
    INSERT INTO usage_records
      (dedupe_key, agent, session_id, project, model, ts,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, web_search_requests, cost_usd, estimated, source_path)
    VALUES
      (@dedupe_key, @agent, @session_id, @project, @model, @ts,
       @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
       @reasoning_tokens, @web_search_requests, @cost_usd, @estimated, @source_path)
    ON CONFLICT(dedupe_key) ${refresh ? `DO UPDATE SET
      session_id=excluded.session_id, project=excluded.project, model=excluded.model,
      ts=excluded.ts, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
      reasoning_tokens=excluded.reasoning_tokens, web_search_requests=excluded.web_search_requests,
      cost_usd=excluded.cost_usd, estimated=excluded.estimated, source_path=excluded.source_path` : 'DO NOTHING'}
  `);
  let inserted = 0;
  let duplicates = 0;
  const run = db.transaction((rows: UsageRecord[]) => {
    for (const r of rows) {
      const existed = refresh && !!db.prepare('SELECT 1 FROM usage_records WHERE dedupe_key = ?').get(r.dedupeKey);
      const info = stmt.run({
        dedupe_key: r.dedupeKey,
        agent: r.agent,
        session_id: r.sessionId,
        project: r.project ?? null,
        model: r.model,
        ts: r.timestamp,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_write_tokens: r.cacheWriteTokens,
        reasoning_tokens: r.reasoningTokens,
        web_search_requests: r.webSearchRequests,
        cost_usd: r.costUSD,
        estimated: r.estimated ? 1 : 0,
        source_path: sourcePath,
      });
      if (info.changes > 0 && !existed) inserted++;
      else duplicates++;
    }
  });
  run(records);
  return { inserted, duplicates };
}

export function getCollectorFingerprint(db: Database.Database, sourcePath: string): FileFingerprint | null {
  const row = db
    .prepare('SELECT fingerprint FROM collector_state WHERE source_path = ?')
    .get(sourcePath) as { fingerprint: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.fingerprint) as FileFingerprint;
  } catch {
    return null;
  }
}

export function setCollectorFingerprint(
  db: Database.Database,
  sourcePath: string,
  agent: string,
  fingerprint: FileFingerprint,
  recordCount: number,
): void {
  db.prepare(
    `INSERT INTO collector_state (source_path, agent, fingerprint, record_count, last_collected_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(source_path) DO UPDATE SET
       agent = excluded.agent,
       fingerprint = excluded.fingerprint,
       record_count = excluded.record_count,
       last_collected_at = excluded.last_collected_at`,
  ).run(sourcePath, agent, JSON.stringify(fingerprint), recordCount);
}

export function clearCollectorState(db: Database.Database, agent?: string): void {
  if (agent) db.prepare('DELETE FROM collector_state WHERE agent = ?').run(agent);
  else db.prepare('DELETE FROM collector_state').run();
}

// ── Aggregation queries ────────────────────────────────────────────────────

export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUSD: number;
  calls: number;
}

const TOTALS_SQL = `
  COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + CASE WHEN agent = 'opencode' THEN reasoning_tokens ELSE 0 END), 0) AS "totalTokens",
  COALESCE(SUM(input_tokens), 0) AS "inputTokens",
  COALESCE(SUM(output_tokens), 0) AS "outputTokens",
  COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
  COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
  COALESCE(SUM(reasoning_tokens), 0) AS "reasoningTokens",
  COALESCE(SUM(cost_usd), 0) AS "costUSD",
  COUNT(*) AS "calls"`;

function sinceClause(days?: number): { sql: string; params: Record<string, string> } {
  if (!days || days <= 0) return { sql: '', params: {} };
  // Calendar-day windows: days=1 means "today since local midnight", days=7
  // the last 7 calendar days including today — matching tokscale/ccusage and
  // user intuition for the 今天/7天/30天 labels.
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return { sql: 'WHERE ts >= @since', params: { since: cutoff.toISOString() } };
}

export function querySummary(db: Database.Database, days?: number): UsageTotals {
  const { sql, params } = sinceClause(days);
  return db.prepare(`SELECT ${TOTALS_SQL} FROM usage_records ${sql}`).get(params) as UsageTotals;
}

export interface AgentBreakdown extends UsageTotals {
  agent: string;
}

export function queryByAgent(db: Database.Database, days?: number): AgentBreakdown[] {
  const { sql, params } = sinceClause(days);
  return db
    .prepare(`SELECT agent, ${TOTALS_SQL} FROM usage_records ${sql} GROUP BY agent ORDER BY "costUSD" DESC`)
    .all(params) as AgentBreakdown[];
}

export interface ModelBreakdown extends UsageTotals {
  model: string;
  agent: string;
}

export function queryByModel(db: Database.Database, days?: number): ModelBreakdown[] {
  const { sql, params } = sinceClause(days);
  return db
    .prepare(
      `SELECT model, agent, ${TOTALS_SQL} FROM usage_records ${sql}
        GROUP BY model, agent ORDER BY "costUSD" DESC LIMIT 50`,
    )
    .all(params) as ModelBreakdown[];
}

export interface DailyUsage extends UsageTotals {
  day: string;
  agent: string;
}

export function queryDaily(db: Database.Database, days = 30): DailyUsage[] {
  const { sql, params } = sinceClause(days);
  return db
    .prepare(
      `SELECT date(ts, 'localtime') AS day, agent, ${TOTALS_SQL}
         FROM usage_records ${sql}
        GROUP BY day, agent ORDER BY day ASC`,
    )
    .all(params) as DailyUsage[];
}

export interface HourlyUsage extends UsageTotals {
  /** Local hour of today, zero-padded '00'..'23'. */
  hour: string;
  agent: string;
}

/** Intraday breakdown for "today" (since local midnight), bucketed by local hour. */
export function queryHourly(db: Database.Database): HourlyUsage[] {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  return db
    .prepare(
      `SELECT strftime('%H', ts, 'localtime') AS hour, agent, ${TOTALS_SQL}
         FROM usage_records WHERE ts >= @since
        GROUP BY hour, agent ORDER BY hour ASC`,
    )
    .all({ since: cutoff.toISOString() }) as HourlyUsage[];
}

export interface ProjectBreakdown extends UsageTotals {
  project: string;
}

export function queryByProject(db: Database.Database, days?: number): ProjectBreakdown[] {
  const { sql, params } = sinceClause(days);
  return db
    .prepare(
      `SELECT COALESCE(project, '(unknown)') AS project, ${TOTALS_SQL}
         FROM usage_records ${sql}
        GROUP BY project ORDER BY "costUSD" DESC LIMIT 50`,
    )
    .all(params) as ProjectBreakdown[];
}

export interface CollectorStatus {
  sourcePath: string;
  agent: string;
  recordCount: number;
  lastCollectedAt: string;
}

export function queryCollectorStatus(db: Database.Database): CollectorStatus[] {
  return db
    .prepare(
      `SELECT source_path AS sourcePath, agent, record_count AS recordCount,
              last_collected_at AS lastCollectedAt
         FROM collector_state ORDER BY agent, source_path`,
    )
    .all() as CollectorStatus[];
}
