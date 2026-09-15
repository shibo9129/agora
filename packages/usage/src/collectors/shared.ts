/**
 * Shared helpers for usage collectors.
 *
 * Parts adapted from codeburn (https://github.com/getagentseal/codeburn),
 * MIT License — see ../../../LICENSE-codeburn.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FileFingerprint } from '../types.js';

export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** Sanitize an absolute cwd into a project slug: strip leading `/`, `/` → `-`. */
export function sanitizeProject(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '-');
}

/** Parse a timestamp that may be seconds or milliseconds since epoch. */
export function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return new Date(ms).toISOString();
}

/** Yield raw lines of a JSONL file (utf-8), skipping blank tails. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.length > 0) yield line;
  }
}

export async function fingerprint(path: string, sqlite = false): Promise<FileFingerprint | null> {
  try {
    const s = await stat(path);
    const wal = sqlite ? await stat(`${path}-wal`).then(w => `${w.ino}:${w.mtimeMs}:${w.size}`).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return 'none'; throw e; }) : '';
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size, parserVersion: 2, wal };
  } catch {
    return null;
  }
}

export function sameFingerprint(a: FileFingerprint | null, b: FileFingerprint | null): boolean {
  return (
    a != null &&
    b != null &&
    a.parserVersion === b.parserVersion &&
    a.wal === b.wal &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.sizeBytes === b.sizeBytes
  );
}

export function safeNumber(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
