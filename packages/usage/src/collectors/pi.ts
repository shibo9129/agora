/**
 * Pi usage collector.
 *
 * Data source: `~/.pi/agent/sessions/<sanitized-cwd>/*.jsonl`
 * (PI_HOME env override). Event format:
 *   line 1:  {"type":"session","id","timestamp","cwd"}
 *   events:  {"type":"model_change","provider","modelId"}
 *            {"type":"message","id","timestamp","message":{"role":...},
 *             "usage":{"input","output","cacheRead","cacheWrite","totalTokens",
 *                      "cost":{"input","output","cacheRead","cacheWrite","total"}}}
 *
 * Only assistant messages carrying a usage block are counted. Pi reports
 * native per-request USD cost; it is used as a fallback when the model is
 * unpriced in the bundled table (honest-zero policy stays).
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { billableOutputTokens, calculateCost } from '../pricing/models.js';
import type { CollectorEnv, UsageCollector, UsageRecord, UsageSource } from '../types.js';
import { asRecord, readLines, safeNumber, sanitizeProject } from './shared.js';

const AGENT = 'pi';

function getSessionsRoot(env?: CollectorEnv): string {
  const environ = env?.env ?? process.env;
  const home = env?.home ?? homedir();
  // PI_CODING_AGENT_SESSION_DIR → PI_CODING_AGENT_DIR/sessions → ~/.pi/agent/sessions
  if (environ['PI_CODING_AGENT_SESSION_DIR']) return environ['PI_CODING_AGENT_SESSION_DIR'];
  const agentDir = environ['PI_CODING_AGENT_DIR'] ?? join(home, '.pi', 'agent');
  return join(agentDir, 'sessions');
}

export const piCollector: UsageCollector = {
  agent: AGENT,
  displayName: 'Pi',

  async discover(env?: CollectorEnv): Promise<UsageSource[]> {
    const root = getSessionsRoot(env);
    const sources: UsageSource[] = [];
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch {
      return [];
    }
    for (const projectDir of projects) {
      const dir = join(root, projectDir);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          sources.push({ kind: 'jsonl', path: join(dir, f), agent: AGENT, project: projectDir });
        }
      }
    }
    return sources;
  },

  async *parse(source: UsageSource): AsyncGenerator<UsageRecord> {
    let sessionId: string | null = null;
    let cwd: string | undefined;
    let model = 'unknown';
    let valid = false;

    for await (const line of readLines(source.path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const event = asRecord(raw);
      if (!event) continue;
      const type = event['type'];

      if (type === 'session') {
        if (typeof event['id'] !== 'string') return;
        sessionId = event['id'];
        if (typeof event['cwd'] === 'string') cwd = event['cwd'];
        valid = true;
        continue;
      }
      if (!valid) return; // first line must be the session meta

      if (type === 'model_change') {
        const modelId = event['modelId'];
        if (typeof modelId === 'string' && modelId.length > 0) model = modelId;
        continue;
      }

      if (type !== 'message') continue;
      const message = asRecord(event['message']);
      if (!message || message['role'] !== 'assistant') continue;
      // usage and model live INSIDE the message object, not on the event.
      const usage = asRecord(message['usage']);
      if (!usage) continue;
      const msgModel = typeof message['model'] === 'string' && message['model'].length > 0 ? message['model'] : null;

      const input = safeNumber(usage['input']);
      const output = safeNumber(usage['output']);
      const cacheRead = safeNumber(usage['cacheRead']);
      const cacheWrite = safeNumber(usage['cacheWrite']);
      if (input + output + cacheRead + cacheWrite === 0) continue;

      const eventId = typeof event['id'] === 'string' ? event['id'] : `${sessionId}:${line.length}`;
      const timestamp =
        typeof event['timestamp'] === 'string'
          ? event['timestamp']
          : typeof message['timestamp'] === 'string'
            ? message['timestamp']
            : new Date(0).toISOString();
      const recordModel = msgModel ?? model;

      let { costUSD } = calculateCost(
        recordModel,
        input,
        billableOutputTokens(AGENT, output, 0),
        cacheWrite,
        cacheRead,
        0,
      );
      if (costUSD === 0) {
        const nativeTotal = safeNumber(asRecord(usage['cost'])?.['total']);
        if (nativeTotal > 0) costUSD = nativeTotal;
      }

      const project = cwd ? sanitizeProject(cwd) : source.project;
      const projectPath = cwd;
      yield {
        agent: AGENT,
        sessionId: sessionId!,
        ...(project !== undefined ? { project } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
        model: recordModel,
        timestamp,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        estimated: false,
        dedupeKey: `${AGENT}:${sessionId}:${eventId}`,
      };
    }
  },
};
