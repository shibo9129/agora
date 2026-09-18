/**
 * Core types for usage collection.
 *
 * The internal record shape is adapted from codeburn's `ParsedProviderCall`
 * (https://github.com/getagentseal/codeburn), MIT License — see LICENSE-codeburn.
 */

/** A single billable unit extracted from an agent's local session data. */
export interface UsageRecord {
  /** Agent id, e.g. 'claude-code' | 'codex' | 'opencode'. */
  agent: string;
  sessionId: string;
  /** Legacy display slug (path with separators flattened to '-'). */
  project?: string;
  /** Real absolute cwd when the agent records one — the readable name. */
  projectPath?: string;
  model: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  /** Computed USD cost; 0 when the model is unpriced (never fabricate). */
  costUSD: number;
  /** True when tokens were estimated (chars/4) rather than provider-reported. */
  estimated: boolean;
  /**
   * Globally unique dedup key, namespaced per agent. Shape is a stability
   * contract: changing it re-counts history. Never change casually.
   */
  dedupeKey: string;
}

/** A discovered unit of raw usage data on disk. */
export interface UsageSource {
  kind: 'jsonl' | 'json' | 'sqlite' | 'dir';
  /** Real file/db path. Virtual paths (db + session id) are allowed when
   *  the collector knows how to split them. */
  path: string;
  agent: string;
  project?: string;
}

export interface CollectorEnv {
  /** Override home dirs for testing; defaults to os.homedir(). */
  home?: string;
  /** Extra env vars layered over process.env (per-agent overrides). */
  env?: NodeJS.ProcessEnv;
}

export interface UsageCollector {
  readonly agent: string;
  readonly displayName: string;
  discover(env?: CollectorEnv): Promise<UsageSource[]>;
  parse(source: UsageSource): AsyncGenerator<UsageRecord>;
}

/** Fingerprint of a source file for change detection (stat quadruple). */
export interface FileFingerprint {
  parserVersion?: number;
  wal?: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  sizeBytes: number;
}
