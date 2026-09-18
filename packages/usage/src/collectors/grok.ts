/**
 * Grok CLI (xAI) usage collector.
 *
 * Data source: `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/usage.json`
 * (default `~/.grok`). Grok writes an authoritative per-session usage ledger:
 *
 *   { sessionId, updatedAt,
 *     session: { inputTokens, outputTokens, cachedReadTokens,
 *                cacheCreationTokens, reasoningTokens, totalTokens,
 *                modelCalls, costUsdTicks, primaryModelId, modelUsage: {…} },
 *     turns: [ { turnNumber, endedAt, …same shape… } ] }
 *
 * Token semantics (verified against the file's own invariants):
 *   totalTokens == inputTokens + outputTokens, `cachedReadTokens` and
 *   `cacheCreationTokens` are SUBSETS of inputTokens, `reasoningTokens` is a
 *   subset of outputTokens. They are split out here into the hub's
 *   Anthropic-style disjoint buckets so the dashboard never double-counts.
 *
 * Cost: `costUsdTicks` is 10^10 ticks per USD (documented by the CLI itself).
 * It is the price Grok actually billed, so it wins over the LiteLLM table;
 * the table is only a fallback when the ledger reports no cost.
 *
 * One record per (session, turn, model) — turns are increments, not running
 * totals, so they sum to the session total without double counting.
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { billableOutputTokens, calculateCost } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { asRecord, safeNumber } from './shared.js';

const AGENT = 'grok';

/** Ticks per USD, per the Grok CLI's own `usage` docs. */
const TICKS_PER_USD = 1e10;

function getGrokHome(env?: CollectorEnv): string {
  const environ = env?.env ?? process.env;
  return environ['GROK_HOME'] ?? join(env?.home ?? homedir(), '.grok');
}

/** Session dirs are the cwd, percent-encoded. Undo it; keep the raw name if not. */
function decodeCwd(dirName: string): string | undefined {
  if (!dirName.includes('%')) return dirName.startsWith('/') ? dirName : undefined;
  try {
    const decoded = decodeURIComponent(dirName);
    return decoded.startsWith('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

interface UsageCounters {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  costUsdTicks?: number;
  primaryModelId?: string;
  modelUsage?: Record<string, unknown>;
}

function counters(v: unknown): UsageCounters | null {
  const r = asRecord(v);
  if (!r) return null;
  return r as UsageCounters;
}

/** Per-model rows of one bucket; falls back to the bucket's primary model. */
function modelRows(bucket: UsageCounters): [string, UsageCounters][] {
  const table = asRecord(bucket.modelUsage);
  const rows: [string, UsageCounters][] = [];
  if (table) {
    for (const [model, raw] of Object.entries(table)) {
      const c = counters(raw);
      if (c) rows.push([model, c]);
    }
  }
  if (rows.length > 0) return rows;
  const fallbackModel =
    typeof bucket.primaryModelId === 'string' && bucket.primaryModelId.length > 0
      ? bucket.primaryModelId
      : 'unknown';
  return [[fallbackModel, bucket]];
}

function recordFor(
  model: string,
  c: UsageCounters,
  meta: { sessionId: string; timestamp: string; project?: string | undefined; projectPath?: string | undefined; dedupeKey: string },
): UsageRecord | null {
  const rawInput = safeNumber(c.inputTokens);
  const output = safeNumber(c.outputTokens);
  const cacheRead = Math.min(safeNumber(c.cachedReadTokens), rawInput);
  const cacheWrite = Math.min(safeNumber(c.cacheCreationTokens), Math.max(0, rawInput - cacheRead));
  const reasoning = safeNumber(c.reasoningTokens);
  // Disjoint buckets: Grok's inputTokens is the superset.
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  if (input + output + cacheRead + cacheWrite <= 0) return null;

  const ticks = safeNumber(c.costUsdTicks);
  const costUSD =
    ticks > 0
      ? ticks / TICKS_PER_USD
      : calculateCost(model, input, billableOutputTokens(AGENT, output, reasoning), cacheWrite, cacheRead, 0).costUSD;

  return {
    agent: AGENT,
    sessionId: meta.sessionId,
    ...(meta.project !== undefined ? { project: meta.project } : {}),
    ...(meta.projectPath !== undefined ? { projectPath: meta.projectPath } : {}),
    model,
    timestamp: meta.timestamp,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    webSearchRequests: 0,
    costUSD,
    estimated: false,
    dedupeKey: meta.dedupeKey,
  };
}

export const grokCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'Grok',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const root = join(getGrokHome(env), 'sessions');
    let cwdDirs: string[];
    try {
      cwdDirs = await readdir(root);
    } catch {
      return [];
    }
    const sources: UsageSource[] = [];
    for (const cwdDir of cwdDirs) {
      const cwd = decodeCwd(cwdDir);
      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(join(root, cwdDir));
      } catch {
        continue; // not a directory (e.g. session_search.sqlite)
      }
      for (const sessionDir of sessionDirs) {
        const path = join(root, cwdDir, sessionDir, 'usage.json');
        sources.push({
          kind: 'json',
          path,
          agent: AGENT,
          ...(cwd !== undefined ? { project: cwd } : {}),
        });
      }
    }
    return sources;
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(source.path, 'utf-8'));
    } catch {
      return; // no usage.json for this session yet, or mid-write
    }
    const root = asRecord(doc);
    if (!root) return;

    const sessionId =
      typeof root['sessionId'] === 'string' && root['sessionId'].length > 0
        ? root['sessionId']
        : (source.path.split('/').slice(-2, -1)[0] ?? source.path);
    const updatedAt = typeof root['updatedAt'] === 'string' ? root['updatedAt'] : new Date(0).toISOString();
    const projectPath = source.project;
    const project = projectPath;

    // Per-turn only, never the session rollup: the rollup equals the sum of
    // the turns, so emitting both double counts, and a rollup row written
    // before the turns landed could not be retracted later (dedupe keys are
    // insert-only). An in-flight turn is simply counted once it ends — the
    // file's fingerprint changes then, so the session is re-parsed.
    const turns = Array.isArray(root['turns']) ? root['turns'] : [];
    for (const rawTurn of turns) {
      const turn = counters(rawTurn);
      if (!turn) continue;
      const turnNumber = safeNumber((turn as Record<string, unknown>)['turnNumber']);
      const endedAt =
        typeof (turn as Record<string, unknown>)['endedAt'] === 'string'
          ? ((turn as Record<string, unknown>)['endedAt'] as string)
          : updatedAt;
      for (const [model, c] of modelRows(turn)) {
        const rec = recordFor(model, c, {
          sessionId,
          timestamp: new Date(endedAt).toISOString(),
          project,
          projectPath,
          dedupeKey: `${AGENT}:${sessionId}:turn:${turnNumber}:${model}`,
        });
        if (rec) yield rec;
      }
    }
  },
};
