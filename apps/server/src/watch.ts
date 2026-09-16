/**
 * Real-time pipeline: watch agent data dirs, incrementally collect on change,
 * broadcast over SSE so every open UI updates live.
 *
 * The collection engine is already incremental (fingerprint skip), so a
 * debounced re-run on change only re-parses the files that actually moved.
 */

import { watch, type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HubEvent {
  type: 'usage-updated' | 'agents-updated' | 'memory-synced' | 'collect-started' | 'collect-finished';
  at: string;
  data?: Record<string, unknown>;
}

export const hubEvents = new EventEmitter();

export function emitHubEvent(type: HubEvent['type'], data?: Record<string, unknown>): void {
  hubEvents.emit('hub-event', { type, at: new Date().toISOString(), ...(data !== undefined ? { data } : {}) } satisfies HubEvent);
}

interface WatchTarget {
  label: string;
  paths: string[];
}

function watchTargets(home: string): WatchTarget[] {
  const env = process.env;
  const hermesHome = env['HERMES_HOME'] ?? join(home, '.hermes');
  return [
    { label: 'codex', paths: [join(env['CODEX_HOME'] ?? join(home, '.codex'), 'sessions')] },
    { label: 'claude', paths: [join(env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'), 'projects')] },
    {
      label: 'opencode',
      paths: [env['OPENCODE_DATA_DIR'] ?? join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'opencode')],
    },
    {
      label: 'pi',
      paths: [env['PI_CODING_AGENT_SESSION_DIR'] ?? join(env['PI_CODING_AGENT_DIR'] ?? join(home, '.pi', 'agent'), 'sessions')],
    },
    // Hermes: watch ONLY its usage data — never the whole home dir, which
    // contains a full Node.js install (~/.hermes/node, tens of thousands of
    // files) and would stall the watcher (and server startup) for minutes.
    { label: 'hermes', paths: [join(hermesHome, 'state.db'), join(hermesHome, 'sessions')] },
  ];
}

export interface RealtimeOptions {
  /** Trigger an incremental collection. Must be single-flight internally. */
  collect: () => Promise<unknown>;
  /** Extra paths to watch (e.g. memory root for external changes). */
  extraPaths?: string[];
  home?: string;
  debounceMs?: number;
}

export function startRealtimeWatch(options: RealtimeOptions): FSWatcher[] {
  const home = options.home ?? homedir();
  const debounceMs = options.debounceMs ?? 2000;
  const watchers: FSWatcher[] = [];

  let pending: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;

  const trigger = async () => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    emitHubEvent('collect-started');
    try {
      const report = (await options.collect()) as { totals?: { inserted?: number; parsed?: number } } | undefined;
      emitHubEvent('usage-updated', {
        inserted: report?.totals?.inserted ?? 0,
        parsed: report?.totals?.parsed ?? 0,
      });
    } catch {
      // collection failure is reported via normal channels; stay quiet here
    } finally {
      emitHubEvent('collect-finished');
      running = false;
      if (dirty) {
        dirty = false;
        void trigger();
      }
    }
  };

  const onFsEvent = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void trigger();
    }, debounceMs);
  };

  const targets = [...watchTargets(home), ...(options.extraPaths?.map((p) => ({ label: 'extra', paths: [p] })) ?? [])];
  for (const target of targets) {
    const w = watch(target.paths, {
      ignoreInitial: true,
      persistent: true,
      depth: 4,
      ignored: (path: string) =>
        path.includes('node_modules') ||
        path.includes('/.git') ||
        path.includes('/.tmp') ||
        path.endsWith('.lock'),
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    });
    w.on('add', onFsEvent);
    w.on('change', onFsEvent);
    w.on('unlink', onFsEvent);
    w.on('error', () => {
      // A target dir that doesn't exist (agent not installed) — fine, skip it.
    });
    watchers.push(w);
  }
  return watchers;
}
