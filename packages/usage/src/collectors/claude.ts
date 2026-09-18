/**
 * Claude Code usage collector.
 *
 * Data source: `<configDir>/projects/<sanitized-cwd>/*.jsonl` (+ `subagents/**`).
 * Config dir precedence: CLAUDE_CONFIG_DIRS > CLAUDE_CONFIG_DIR > ~/.claude.
 *
 * Only `assistant` journal entries with `message.usage` + `message.model` are
 * counted. Streaming restatements of the same `message.id` are deduped keeping
 * the LAST occurrence (timestamp from the first).
 *
 * Parsing logic adapted from codeburn's `src/parser.ts`
 * (https://github.com/getagentseal/codeburn), MIT License — see LICENSE-codeburn.
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, join, resolve } from 'node:path';

import { billableOutputTokens, calculateCost } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { asRecord, expandHome, readLines, safeNumber, sanitizeProject } from './shared.js';

const AGENT = 'claude-code';

async function getConfigDirs(env?: CollectorEnv): Promise<string[]> {
  const home = env?.home ?? homedir();
  const environ = env?.env ?? process.env;
  const multi = environ['CLAUDE_CONFIG_DIRS'];
  if (multi) {
    const dirs = multi
      .split(pathDelimiter)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => resolve(expandHome(s, home)));
    if (dirs.length > 0) return [...new Set(dirs)];
  }
  const single = environ['CLAUDE_CONFIG_DIR'];
  if (single) return [resolve(expandHome(single, home))];
  return [join(home, '.claude')];
}

async function collectJsonlFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
      else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(projectDir, 0);
  return out;
}

interface AssistantEntry {
  msgId: string;
  timestamp: string;
  sessionId?: string | undefined;
  /** Session cwd — the readable project name behind the flattened slug. */
  cwd?: string | undefined;
  model: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  webSearchRequests: number;
  speed: 'standard' | 'fast';
}

function extractCacheCreation(usage: Record<string, unknown>): { total: number; oneHour: number } {
  const legacy = safeNumber(usage['cache_creation_input_tokens']);
  const split = asRecord(usage['cache_creation']);
  const fiveMin = safeNumber(split?.['ephemeral_5m_input_tokens']);
  const oneHour = safeNumber(split?.['ephemeral_1h_input_tokens']);
  if (fiveMin + oneHour === 0) return { total: legacy, oneHour: 0 };
  const total = Math.max(legacy, fiveMin + oneHour);
  return { total, oneHour: Math.min(oneHour, total) };
}

function parseAssistantEntry(line: string): AssistantEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = asRecord(raw);
  if (!entry || entry['type'] !== 'assistant') return null;
  const message = asRecord(entry['message']);
  if (!message) return null;
  const usage = asRecord(message['usage']);
  const model = message['model'];
  if (!usage || typeof model !== 'string' || model.length === 0) return null;

  const cache = extractCacheCreation(usage);
  const msgId =
    typeof message['id'] === 'string' && message['id'].length > 0
      ? (message['id'] as string)
      : `claude:${String(entry['timestamp'] ?? '')}`;
  const speed = usage['speed'] === 'fast' ? ('fast' as const) : ('standard' as const);
  return {
    msgId,
    timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : new Date(0).toISOString(),
    sessionId: typeof entry['sessionId'] === 'string' ? entry['sessionId'] : undefined,
    cwd: typeof entry['cwd'] === 'string' && entry['cwd'].length > 0 ? entry['cwd'] : undefined,
    model,
    input: safeNumber(usage['input_tokens']),
    output: safeNumber(usage['output_tokens']),
    cacheWrite5m: cache.total,
    cacheWrite1h: cache.oneHour,
    cacheRead: safeNumber(usage['cache_read_input_tokens']),
    webSearchRequests: safeNumber(asRecord(usage['server_tool_use'])?.['web_search_requests']),
    speed,
  };
}

export const claudeCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'Claude Code',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const sources: UsageSource[] = [];
    const seen = new Set<string>();
    for (const configDir of await getConfigDirs(env)) {
      const projectsDir = join(configDir, 'projects');
      let slugs: string[];
      try {
        slugs = await readdir(projectsDir);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const projectDir = join(projectsDir, slug);
        const files = await collectJsonlFiles(projectDir);
        for (const path of files) {
          const resolved = resolve(path);
          if (seen.has(resolved)) continue;
          seen.add(resolved);
          sources.push({ kind: 'jsonl', path, agent: AGENT, project: slug });
        }
      }
    }
    return sources;
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    // Within-file streaming dedup: same message.id restated multiple times;
    // keep the LAST occurrence, with the timestamp of the FIRST.
    const byMsgId = new Map<string, AssistantEntry>();
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let fallbackSessionId = '';
    for await (const line of readLines(source.path)) {
      const entry = parseAssistantEntry(line);
      if (!entry) continue;
      if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
      if (!cwd && entry.cwd) cwd = entry.cwd;
      const prev = byMsgId.get(entry.msgId);
      byMsgId.set(entry.msgId, prev ? { ...entry, timestamp: prev.timestamp } : entry);
    }
    if (!sessionId) {
      // Derive a stable fallback from the file name for grouping.
      fallbackSessionId = source.path.split('/').pop()?.replace(/\.jsonl$/, '') ?? source.path;
    }
    const project = source.project ?? sanitizeProject(source.path);

    for (const entry of byMsgId.values()) {
      const { costUSD } = calculateCost(
        entry.model,
        entry.input,
        billableOutputTokens(AGENT, entry.output, 0),
        entry.cacheWrite5m,
        entry.cacheRead,
        entry.webSearchRequests,
        entry.speed,
        entry.cacheWrite1h,
      );
      yield {
        agent: AGENT,
        sessionId: sessionId ?? fallbackSessionId,
        project,
        ...(cwd !== undefined ? { projectPath: cwd } : {}),
        model: entry.model,
        timestamp: entry.timestamp,
        inputTokens: entry.input,
        outputTokens: entry.output,
        cacheReadTokens: entry.cacheRead,
        cacheWriteTokens: entry.cacheWrite5m,
        reasoningTokens: 0,
        webSearchRequests: entry.webSearchRequests,
        costUSD,
        estimated: false,
        dedupeKey: `${AGENT}:${entry.msgId}`,
      };
    }
  },
};
