/**
 * Codex usage collector.
 *
 * Data source: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` plus
 * `archived_sessions/rollout-*.jsonl` (basename-deduped, dated wins).
 *
 * Tokens come from `token_count`/`event_msg` events carrying
 * `info.last_token_usage` (per-turn delta, preferred) and
 * `info.total_token_usage` (cumulative counters). The cumulative→delta
 * conversion, fork-replay cutoff, and dedup-key shape below follow codeburn's
 * `src/providers/codex.ts` (https://github.com/getagentseal/codeburn),
 * MIT License — see LICENSE-codeburn.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { billableOutputTokens, calculateCost, getModelCosts } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { asRecord, readLines, safeNumber, sanitizeProject } from './shared.js';

const AGENT = 'codex';

function getCodexHome(env?: CollectorEnv): string {
  const environ = env?.env ?? process.env;
  const home = env?.home ?? homedir();
  return environ['CODEX_HOME'] ?? join(home, '.codex');
}

async function listRolloutFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl
  const sessionsDir = join(root, 'sessions');
  try {
    for (const yyyy of await readdir(sessionsDir)) {
      if (!/^\d{4}$/.test(yyyy)) continue;
      for (const mm of await readdir(join(sessionsDir, yyyy)).catch(() => [] as string[])) {
        if (!/^\d{2}$/.test(mm)) continue;
        for (const dd of await readdir(join(sessionsDir, yyyy, mm)).catch(() => [] as string[])) {
          if (!/^\d{2}$/.test(dd)) continue;
          const dayDir = join(sessionsDir, yyyy, mm, dd);
          for (const f of await readdir(dayDir).catch(() => [] as string[])) {
            if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(join(dayDir, f));
          }
        }
      }
    }
  } catch {
    // no dated sessions dir
  }
  return out;
}

async function listArchivedFiles(root: string): Promise<string[]> {
  const dir = join(root, 'archived_sessions');
  try {
    return (await readdir(dir))
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

interface SessionMeta {
  dedupeSessionId: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  forkedFromId?: string;
  forkCutoff?: string; // ISO; replayed events before this are skipped
}

async function readSessionMeta(path: string): Promise<SessionMeta | null> {
  // First line may exceed 27KB (base_instructions); read a bounded prefix.
  let firstLine: string;
  try {
    const buf = await readFile(path, { encoding: 'utf-8' });
    const nl = buf.indexOf('\n');
    firstLine = nl === -1 ? buf : buf.slice(0, nl);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(firstLine);
  } catch {
    return null;
  }
  const entry = asRecord(raw);
  if (!entry || entry['type'] !== 'session_meta') return null;
  const payload = asRecord(entry['payload']);
  if (!payload) return null;

  const fallbackId = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path;
  const sessionId = typeof payload['id'] === 'string' ? payload['id'] : typeof payload['session_id'] === 'string' ? payload['session_id'] : fallbackId;
  const nested = asRecord(asRecord(asRecord(payload['source'])?.['subagent'])?.['thread_spawn']);
  const forkedFromId =
    (typeof payload['forked_from_id'] === 'string' && payload['forked_from_id']) ||
    (typeof payload['parent_thread_id'] === 'string' && payload['parent_thread_id']) ||
    (typeof nested?.['parent_thread_id'] === 'string' && (nested['parent_thread_id'] as string)) ||
    undefined;
  const meta: SessionMeta = { sessionId, dedupeSessionId: typeof payload['session_id'] === 'string' ? payload['session_id'] : fallbackId };
  if (typeof payload['cwd'] === 'string') meta.cwd = payload['cwd'];
  if (typeof payload['model'] === 'string') meta.model = payload['model'];
  if (forkedFromId) {
    meta.forkedFromId = forkedFromId;
    const ts = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
    if (Number.isFinite(ts)) meta.forkCutoff = new Date(ts + 5000).toISOString();
  }
  return meta;
}

function resolveModel(info: Record<string, unknown> | null, sessionModel: string | undefined): string {
  const candidates = [
    info?.['model'],
    info?.['model_name'],
    sessionModel,
    'unknown',
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return 'unknown';
}

export const codexCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'Codex',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const root = getCodexHome(env);
    const dated = await listRolloutFiles(root);
    const archived = await listArchivedFiles(root);
    const seenBasenames = new Set(dated.map((p) => p.split('/').pop()));
    const sources: UsageSource[] = dated.map((path) => ({ kind: 'jsonl', path, agent: AGENT }));
    for (const path of archived) {
      const base = path.split('/').pop();
      if (base && seenBasenames.has(base)) continue;
      sources.push({ kind: 'jsonl', path, agent: AGENT });
    }
    return sources;
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    const meta = await readSessionMeta(source.path);
    if (!meta) return;
    const project = meta.cwd ? sanitizeProject(meta.cwd) : undefined;
    const projectPath = meta.cwd;
    let sessionModel = meta.model;

    // Cumulative counters (always advance to the latest total, whichever
    // delta branch was used — mixing last/total events with a stale baseline
    // would double-count the whole window).
    let prevCumulativeTotal: number | null = null;
    let prevInput = 0;
    let prevCached = 0;
    let prevCacheWrite = 0;
    let prevOutput = 0;
    let prevReasoning = 0;

    for await (const line of readLines(source.path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = asRecord(raw);
      if (!entry) continue;
      const type = entry['type'];
      const payload = asRecord(entry['payload']);
      if (!payload) continue;
      const payloadType = payload['type'];

      if (type === 'turn_context' || payloadType === 'turn_context') {
        if (typeof payload['model'] === 'string' && payload['model'].length > 0) {
          sessionModel = payload['model'];
        }
        continue;
      }

      const isTokenEvent =
        (type === 'event_msg' || type === 'token_count') && payloadType === 'token_count';
      if (!isTokenEvent) continue;

      // Fork replay cutoff: events replayed from the parent thread are skipped.
      const ts = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : '';
      if (meta.forkCutoff && ts && ts < meta.forkCutoff) continue;

      const info = asRecord(payload['info']);
      const total = asRecord(info?.['total_token_usage']);
      const cumulativeTotal = safeNumber(total?.['total_tokens']);

      // (1) Duplicate event guard: cumulative unmoved → same event re-emitted.
      if (prevCumulativeTotal !== null && cumulativeTotal === prevCumulativeTotal) continue;
      prevCumulativeTotal = cumulativeTotal;

      // (2) Delta for this event: last_token_usage first, cumulative diff fallback.
      const last = asRecord(info?.['last_token_usage']);
      let input: number;
      let cached: number;
      let cacheWrite: number;
      let output: number;
      let reasoning: number;
      if (last) {
        input = safeNumber(last['input_tokens']);
        cached = safeNumber(last['cached_input_tokens']);
        cacheWrite = safeNumber(last['cache_write_input_tokens']);
        output = safeNumber(last['output_tokens']);
        reasoning = safeNumber(last['reasoning_output_tokens']);
      } else {
        if (!total || cumulativeTotal <= 0) {
          // (3) still advance baselines when possible
          if (total) {
            prevInput = safeNumber(total['input_tokens']);
            prevCached = safeNumber(total['cached_input_tokens']);
            prevCacheWrite = safeNumber(total['cache_write_input_tokens']);
            prevOutput = safeNumber(total['output_tokens']);
            prevReasoning = safeNumber(total['reasoning_output_tokens']);
          }
          continue;
        }
        input = safeNumber(total['input_tokens']) - prevInput;
        cached = safeNumber(total['cached_input_tokens']) - prevCached;
        cacheWrite = safeNumber(total['cache_write_input_tokens']) - prevCacheWrite;
        output = safeNumber(total['output_tokens']) - prevOutput;
        reasoning = safeNumber(total['reasoning_output_tokens']) - prevReasoning;
      }

      // (3) Always advance baselines to the current cumulative counters.
      if (total) {
        prevInput = safeNumber(total['input_tokens']);
        prevCached = safeNumber(total['cached_input_tokens']);
        prevCacheWrite = safeNumber(total['cache_write_input_tokens']);
        prevOutput = safeNumber(total['output_tokens']);
        prevReasoning = safeNumber(total['reasoning_output_tokens']);
      }

      // (4) All-zero events carry no usage.
      if (input + cached + output + reasoning <= 0) continue;

      const model = resolveModel(info, sessionModel);

      // Normalize OpenAI semantics → Anthropic semantics:
      // input_tokens INCLUDES cached tokens; cache_write is a subset of input.
      const uncachedInput = Math.max(0, input - cached);
      const cacheWriteClamped = Math.min(Math.max(0, cacheWrite), uncachedInput);
      const billedCacheWrite =
        cacheWriteClamped > 0 && getModelCosts(model)?.cacheWriteCostIsExplicit ? cacheWriteClamped : 0;
      const billedInput = uncachedInput - billedCacheWrite;

      const { costUSD } = calculateCost(
        model,
        billedInput,
        billableOutputTokens(AGENT, output, reasoning),
        billedCacheWrite,
        Math.max(0, cached),
        0,
      );

      // Dedup key uses the fork PARENT id as namespace (replays collide with
      // the parent's events exactly) and cumulative values (delta-based keys
      // would fork falsely after the 5s replay cutoff).
      const ns = meta.forkedFromId ?? meta.dedupeSessionId;
      const dedupeKey = `codex:${ns}:${cumulativeTotal}:${safeNumber(total?.['input_tokens'])}:${safeNumber(
        total?.['cached_input_tokens'],
      )}:${safeNumber(total?.['output_tokens'])}:${safeNumber(total?.['reasoning_output_tokens'])}`;

      yield {
        agent: AGENT,
        sessionId: meta.sessionId,
        ...(project !== undefined ? { project } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
        model,
        timestamp: ts || new Date(0).toISOString(),
        inputTokens: billedInput,
        outputTokens: Math.max(0, output),
        cacheReadTokens: Math.max(0, cached),
        cacheWriteTokens: billedCacheWrite,
        reasoningTokens: Math.max(0, reasoning),
        webSearchRequests: 0,
        costUSD,
        estimated: false,
        dedupeKey,
      };
    }
  },
};
