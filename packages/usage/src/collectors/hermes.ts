/**
 * Hermes usage collector.
 *
 * Data source: `$HERMES_HOME/state.db` (default `~/.hermes/state.db`).
 * Hermes keeps per-(session, model, task) cumulative counters in
 * `session_model_usage`; rows are upserted by the gateway as the session
 * advances, so this collector emits one record per row keyed by
 * `hermes:<session>:<model>:<task>` and relies on the engine's refresh-upsert
 * to keep counters current. Older databases without that table fall back to
 * the per-session rollup columns on `sessions`. Read-only — the DB is opened
 * via openSqliteReadonly and never mutated.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { billableOutputTokens, calculateCost } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { openSqliteReadonly, parseTimestamp, safeNumber, sanitizeProject } from './shared.js';

const AGENT = 'hermes';

function getHermesHome(env?: CollectorEnv): string {
  const environ = env?.env ?? process.env;
  return environ['HERMES_HOME'] ?? join(env?.home ?? homedir(), '.hermes');
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

interface ModelUsageRow {
  session_id: string;
  model: string;
  task: string;
  api_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  last_seen: number | null;
  first_seen: number | null;
  cwd: string | null;
}

interface SessionRollupRow {
  id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  started_at: number | null;
  last_activity_at: number | null;
  cwd: string | null;
}

function costFor(model: string, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number, nativeCost: number): number {
  let { costUSD } = calculateCost(
    model,
    input,
    billableOutputTokens(AGENT, output, reasoning),
    cacheWrite,
    cacheRead,
    0,
  );
  // Provider-reported cost is only a fallback when pricing is missing.
  if (costUSD === 0 && nativeCost > 0) costUSD = nativeCost;
  return costUSD;
}

export const hermesCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'Hermes',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const path = join(getHermesHome(env), 'state.db');
    if (!existsSync(path)) return [];
    return [{ kind: 'sqlite', path, agent: AGENT }];
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    const db = openSqliteReadonly(source.path, 'hermes');
    try {
      if (!hasTable(db, 'sessions')) return;

      if (hasTable(db, 'session_model_usage')) {
        const rows = db
          .prepare(
            `SELECT u.session_id, u.model, u.task,
                    u.api_call_count, u.input_tokens, u.output_tokens,
                    u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens,
                    u.estimated_cost_usd, u.actual_cost_usd, u.first_seen, u.last_seen,
                    s.cwd
               FROM session_model_usage u
               LEFT JOIN sessions s ON s.id = u.session_id`,
          )
          .all() as ModelUsageRow[];
        for (const row of rows) {
          const input = safeNumber(row.input_tokens);
          const output = safeNumber(row.output_tokens);
          const reasoning = safeNumber(row.reasoning_tokens);
          const cacheRead = safeNumber(row.cache_read_tokens);
          const cacheWrite = safeNumber(row.cache_write_tokens);
          if (input + output + reasoning + cacheRead + cacheWrite <= 0) continue;
          const model = row.model || 'unknown';
          const nativeCost = Math.max(safeNumber(row.actual_cost_usd), safeNumber(row.estimated_cost_usd));
          const project = row.cwd ? sanitizeProject(row.cwd) : undefined;
          yield {
            agent: AGENT,
            sessionId: row.session_id,
            ...(project !== undefined ? { project } : {}),
            model,
            timestamp: parseTimestamp(row.last_seen ?? row.first_seen ?? 0),
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD: costFor(model, input, output, reasoning, cacheRead, cacheWrite, nativeCost),
            estimated: false,
            dedupeKey: `${AGENT}:${row.session_id}:${model}:${row.task}`,
          };
        }
        return;
      }

      // Legacy fallback: per-session rollup columns only.
      const rows = db
        .prepare(
          `SELECT id, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, reasoning_tokens,
                  estimated_cost_usd, actual_cost_usd, started_at, last_activity_at, cwd
             FROM sessions`,
        )
        .all() as SessionRollupRow[];
      for (const row of rows) {
        const input = safeNumber(row.input_tokens);
        const output = safeNumber(row.output_tokens);
        const reasoning = safeNumber(row.reasoning_tokens);
        const cacheRead = safeNumber(row.cache_read_tokens);
        const cacheWrite = safeNumber(row.cache_write_tokens);
        if (input + output + reasoning + cacheRead + cacheWrite <= 0) continue;
        const model = row.model || 'unknown';
        const nativeCost = Math.max(safeNumber(row.actual_cost_usd), safeNumber(row.estimated_cost_usd));
        const project = row.cwd ? sanitizeProject(row.cwd) : undefined;
        yield {
          agent: AGENT,
          sessionId: row.id,
          ...(project !== undefined ? { project } : {}),
          model,
          timestamp: parseTimestamp(row.last_activity_at ?? row.started_at ?? 0),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: reasoning,
          webSearchRequests: 0,
          costUSD: costFor(model, input, output, reasoning, cacheRead, cacheWrite, nativeCost),
          estimated: false,
          dedupeKey: `${AGENT}:${row.id}:session-level`,
        };
      }
    } finally {
      db.close();
    }
  },
};
