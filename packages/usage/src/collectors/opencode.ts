/**
 * OpenCode usage collector.
 *
 * Data source: `$OPENCODE_DATA_DIR` (exact) or `$XDG_DATA_HOME/opencode` or
 * `~/.local/share/opencode`; any `opencode*.db` with session/message/part
 * tables. OpenCode 1.1+ stores sessions in SQLite; the DB is opened read-only
 * and never mutated by this collector.
 *
 * Message/part extraction + timestamp heuristics adapted from codeburn's
 * `src/providers/sqlite-session-parser.ts` and `src/providers/session-message.ts`
 * (https://github.com/getagentseal/codeburn), MIT License — see LICENSE-codeburn.
 */

import Database from 'better-sqlite3';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { billableOutputTokens, calculateCost } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { asRecord, openSqliteReadonly, parseTimestamp, safeNumber, sanitizeProject } from './shared.js';

const AGENT = 'opencode';

function getDataDir(env?: CollectorEnv): string {
  const environ = env?.env ?? process.env;
  const home = env?.home ?? homedir();
  if (environ['OPENCODE_DATA_DIR']) return environ['OPENCODE_DATA_DIR'];
  const xdg = environ['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdg, 'opencode');
}

function hasSchema(db: Database.Database): boolean {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  return tables.has('session') && tables.has('message') && tables.has('part');
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  message_id: string;
  data: string;
}

interface SessionFallbackRow {
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  model: string | null;
}

function* parseSession(
  db: Database.Database,
  session: SessionRow,
): Generator<UsageRecord> {
  // Session tree: this session + all descendant sessions (subagent sessions).
  // Archived sessions are INCLUDED — archived means hidden in the UI, not
  // un-billed; a usage hub must account for their historical cost.
  const messages = db
    .prepare(
      `WITH RECURSIVE session_tree(id) AS (
         SELECT id FROM "session" WHERE id = ?
         UNION ALL
         SELECT s.id FROM "session" s
           JOIN session_tree t ON s.parent_id = t.id
       )
       SELECT m.id, m.session_id, m.time_created, m.data
         FROM message m JOIN session_tree t ON m.session_id = t.id
        ORDER BY m.time_created, m.id`,
    )
    .all(session.id) as MessageRow[];

  const partsStmt = db.prepare(
    `WITH RECURSIVE session_tree(id) AS (
       SELECT id FROM "session" WHERE id = ?
       UNION ALL
       SELECT s.id FROM "session" s
         JOIN session_tree t ON s.parent_id = t.id
     )
     SELECT p.message_id, p.data
       FROM part p JOIN session_tree t ON p.session_id = t.id`,
  );
  const parts = partsStmt.all(session.id) as PartRow[];
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const p of parts) {
    const data = asRecord(JSON.parse(p.data));
    if (!data) continue;
    const list = partsByMessage.get(p.message_id) ?? [];
    list.push(data);
    partsByMessage.set(p.message_id, list);
  }

  const project = session.directory
    ? sanitizeProject(session.directory)
    : session.title
      ? sanitizeProject(session.title)
      : undefined;

  let emitted = 0;
  for (const msg of messages) {
    let data: Record<string, unknown> | null = null;
    try {
      data = asRecord(JSON.parse(msg.data));
    } catch {
      continue;
    }
    if (!data) continue;
    const role = data['role'];
    if (role !== 'assistant' && role !== 'model') continue;

    const tokens = asRecord(data['tokens']);
    const usage = asRecord(data['usage']);
    const cache = asRecord(tokens?.['cache']);
    const input = safeNumber(tokens?.['input'] ?? usage?.['input_tokens']);
    const output = safeNumber(tokens?.['output'] ?? usage?.['output_tokens']);
    const reasoning = safeNumber(tokens?.['reasoning']);
    const cacheRead = safeNumber(cache?.['read'] ?? usage?.['cache_read_input_tokens']);
    const cacheWrite = safeNumber(cache?.['write'] ?? usage?.['cache_creation_input_tokens']);
    const nativeCost = safeNumber(data['cost']);

    const msgParts = partsByMessage.get(msg.id) ?? [];
    const allZero = input + output + reasoning + cacheRead + cacheWrite === 0;
    const hasSubstance = msgParts.some((p) =>
      ['text', 'tool', 'tool-call', 'tool_call', 'tool-result', 'tool_result', 'reasoning', 'file'].includes(
        String(p['type']),
      ),
    );
    if (allZero && nativeCost === 0 && !hasSubstance) continue;

    const model =
      (typeof data['modelID'] === 'string' && (data['modelID'] as string)) ||
      (typeof data['model'] === 'string' && (data['model'] as string)) ||
      'unknown';

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

    emitted++;
    yield {
      agent: AGENT,
      sessionId: session.id,
      ...(project !== undefined ? { project } : {}),
      model,
      timestamp: parseTimestamp(msg.time_created),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      webSearchRequests: 0,
      costUSD,
      estimated: false,
      dedupeKey: `${AGENT}:${session.id}:${msg.id}`,
    };
  }

  // Session-level fallback: no message-level calls but the session row itself
  // carries rollup counters (crash-only sessions, compacted history).
  if (emitted === 0 && messages.length > 0) {
    const row = db
      .prepare(
        `SELECT cost, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, CAST(model AS TEXT) AS model
           FROM "session" WHERE id = ?`,
      )
      .get(session.id) as SessionFallbackRow | undefined;
    if (row) {
      const input = safeNumber(row.tokens_input);
      const output = safeNumber(row.tokens_output);
      const reasoning = safeNumber(row.tokens_reasoning);
      if (input + output + reasoning > 0) {
        let model = 'unknown';
        const modelBlob = asRecord(row.model ? JSON.parse(row.model) : null);
        if (modelBlob && typeof modelBlob['id'] === 'string') {
          const providerID = typeof modelBlob['providerID'] === 'string' ? `${modelBlob['providerID']}/` : '';
          model = `${providerID}${modelBlob['id']}`;
        }
        const cacheRead = safeNumber(row.tokens_cache_read);
        const cacheWrite = safeNumber(row.tokens_cache_write);
        let { costUSD } = calculateCost(
          model,
          input,
          billableOutputTokens(AGENT, output, reasoning),
          cacheWrite,
          cacheRead,
          0,
        );
        if (costUSD === 0) costUSD = safeNumber(row.cost);
        yield {
          agent: AGENT,
          sessionId: session.id,
          ...(project !== undefined ? { project } : {}),
          model,
          timestamp: parseTimestamp(messages[0]!.time_created),
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          reasoningTokens: reasoning,
          webSearchRequests: 0,
          costUSD,
          estimated: false,
          dedupeKey: `${AGENT}:${session.id}:session-level`,
        };
      }
    }
  }
}

export const opencodeCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'OpenCode',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const dir = getDataDir(env);
    const prefix = (env?.env ?? process.env)['OPENCODE_DB_PREFIX'] || 'opencode';
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
      .map((f) => ({ kind: 'sqlite', path: join(dir, f), agent: AGENT }));
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    const db = openSqliteReadonly(source.path, 'opencode');
    try {
      if (!hasSchema(db)) return;
      const sessions = db
        .prepare(
          `SELECT id, directory, title, time_created FROM "session"
            WHERE parent_id IS NULL
            ORDER BY time_created DESC`,
        )
        .all() as SessionRow[];
      for (const session of sessions) {
        yield* parseSession(db, session);
      }
    } finally {
      db.close();
    }
  },
};
