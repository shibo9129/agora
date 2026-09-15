/**
 * Filesystem indexer: gitignore-aware walk → aggregated dir sizes →
 * incremental diff into kb_entries + FTS name index.
 *
 * Symlinks are never followed (loop safety). Dotfiles except well-known
 * ignore files are skipped by default.
 */

import type Database from 'better-sqlite3';
import ignore, { type Ignore } from 'ignore';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { KbEntry } from './types.js';

const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
];

const MAX_ENTRIES = 500_000;

async function loadIgnore(rootPath: string, extraIgnores: readonly string[] = []): Promise<Ignore> {
  const ig = ignore().add(DEFAULT_IGNORES).add(extraIgnores as string[]);
  for (const file of ['.gitignore', '.ignore']) {
    try {
      const content = await readFile(join(rootPath, file), 'utf-8');
      ig.add(content);
    } catch {
      // no such ignore file
    }
  }
  return ig;
}

interface WalkedEntry {
  path: string; // relative posix
  name: string;
  kind: 'file' | 'dir';
  size: number; // files: own size; dirs: aggregated later
  mtimeMs: number;
  depth: number;
  ext?: string;
}

async function walk(rootPath: string, ig: Ignore): Promise<WalkedEntry[]> {
  const out: WalkedEntry[] = [];
  const walkDir = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (out.length > MAX_ENTRIES) return;
    let items;
    try {
      items = await readdir(absDir);
    } catch {
      return;
    }
    for (const name of items) {
      if (out.length > MAX_ENTRIES) return;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (ig.ignores(rel)) continue;
      const abs = join(absDir, name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        out.push({ path: rel, name, kind: 'dir', size: 0, mtimeMs: st.mtimeMs, depth });
        await walkDir(abs, rel, depth + 1);
      } else if (st.isFile()) {
        const ext = extname(name).slice(1).toLowerCase();
        const entry: WalkedEntry = { path: rel, name, kind: 'file', size: st.size, mtimeMs: st.mtimeMs, depth };
        if (ext) entry.ext = ext;
        out.push(entry);
      }
    }
  };
  await walkDir(rootPath, '', 1);
  return out;
}

/** Aggregate file sizes + file/dir counts into ancestor directories (bottom-up). */
function aggregateDirs(entries: WalkedEntry[]): Map<string, { size: number; fileCount: number; dirCount: number }> {
  const agg = new Map<string, { size: number; fileCount: number; dirCount: number }>();
  const ensure = (p: string) => {
    let v = agg.get(p);
    if (!v) {
      v = { size: 0, fileCount: 0, dirCount: 0 };
      agg.set(p, v);
    }
    return v;
  };
  ensure('');
  for (const e of entries) {
    if (e.kind === 'dir') ensure(e.path);
  }
  // Deepest-first so parents accumulate after children are complete.
  const sorted = [...entries].sort((a, b) => b.depth - a.depth || (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1));
  for (const e of sorted) {
    const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    const p = ensure(parent);
    if (e.kind === 'file') {
      p.size += e.size;
      p.fileCount += 1;
    } else {
      const own = ensure(e.path);
      p.size += own.size;
      p.fileCount += own.fileCount;
      p.dirCount += own.dirCount + 1; // the child dir itself
    }
  }
  return agg;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  totalBytes: number;
  durationMs: number;
  truncated: boolean;
}

export async function scanKb(
  db: Database.Database,
  kbId: string,
  rootPath: string,
  options: { extraIgnores?: readonly string[] } = {},
): Promise<ScanResult> {
  const t0 = Date.now();
  const ig = await loadIgnore(rootPath, options.extraIgnores);
  const walked = await walk(rootPath, ig);
  const truncated = walked.length > MAX_ENTRIES;
  const dirAgg = aggregateDirs(walked);

  // Current db state
  const existing = new Map<string, { size: number; mtime_ms: number; kind: string; file_count: number; dir_count: number }>();
  for (const row of db.prepare('SELECT path, size, mtime_ms, kind, file_count, dir_count FROM kb_entries WHERE kb_id = ?').all(kbId) as {
    path: string;
    size: number;
    mtime_ms: number;
    kind: string;
    file_count: number;
    dir_count: number;
  }[]) {
    existing.set(row.path, row);
  }

  const seen = new Set<string>();
  let added = 0;
  let updated = 0;

  const upsert = db.prepare(
    `INSERT INTO kb_entries (kb_id, path, name, kind, size, mtime_ms, depth, ext, file_count, dir_count)
     VALUES (@kbId, @path, @name, @kind, @size, @mtimeMs, @depth, @ext, @fileCount, @dirCount)
     ON CONFLICT(kb_id, path) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, size = excluded.size,
       mtime_ms = excluded.mtime_ms, depth = excluded.depth, ext = excluded.ext,
       file_count = excluded.file_count, dir_count = excluded.dir_count`,
  );
  const ftsUpsert = db.prepare('INSERT INTO kb_fts (kb_id, path, name) VALUES (?, ?, ?)');
  const ftsDeleteAll = db.prepare('DELETE FROM kb_fts WHERE kb_id = ?');
  const entryDelete = db.prepare('DELETE FROM kb_entries WHERE kb_id = ? AND path = ?');

  const toKbEntry = (e: WalkedEntry): KbEntry => {
    const agg = e.kind === 'dir' ? dirAgg.get(e.path) : undefined;
    const entry: KbEntry = {
      kbId,
      path: e.path,
      name: e.name,
      kind: e.kind,
      size: e.kind === 'dir' ? (agg?.size ?? 0) : e.size,
      mtimeMs: e.mtimeMs,
      depth: e.depth,
      fileCount: agg?.fileCount ?? 0,
      dirCount: agg?.dirCount ?? 0,
    };
    if (e.ext) entry.ext = e.ext;
    return entry;
  };

  const tx = db.transaction(() => {
    for (const e of walked) {
      seen.add(e.path);
      const prev = existing.get(e.path);
      const entry = toKbEntry(e);
      if (!prev) {
        added++;
        upsert.run({ ...entry, ext: entry.ext ?? null });
      } else if (
        prev.size !== entry.size ||
        prev.mtime_ms !== entry.mtimeMs ||
        prev.kind !== entry.kind ||
        // Aggregated-count drift (e.g. upgrading from a build without counts)
        // must self-heal even when sizes/mtimes are unchanged.
        prev.file_count !== entry.fileCount ||
        prev.dir_count !== entry.dirCount
      ) {
        updated++;
        upsert.run({ ...entry, ext: entry.ext ?? null });
      }
    }
    // FTS name index is rebuilt wholesale each scan: cheap (single transaction),
    // self-healing, and immune to FTS5's lack of UNIQUE constraints.
    ftsDeleteAll.run(kbId);
    for (const e of walked) ftsUpsert.run(kbId, e.path, e.name);
  });
  tx();

  // Removals: previously indexed paths no longer on disk.
  // The root entry '' is written below after this step, not by walk() —
  // exclude it from staleness detection.
  let removed = 0;
  const stalePaths: string[] = [];
  for (const path of existing.keys()) {
    if (path !== '' && !seen.has(path)) stalePaths.push(path);
  }
  if (stalePaths.length > 0) {
    // FTS rows for stale paths are already gone (wholesale rebuild above).
    const txDel = db.transaction(() => {
      for (const path of stalePaths) {
        removed++;
        entryDelete.run(kbId, path);
      }
    });
    txDel();
  }

  // Root entry ('') keeps the kb's total size for fast list queries.
  const rootAgg = dirAgg.get('') ?? { size: 0, fileCount: 0, dirCount: 0 };
  const rootMtime = walked.length > 0 ? Math.max(...walked.map((e) => e.mtimeMs)) : 0;
  upsert.run({
    kbId,
    path: '',
    name: basename(rootPath),
    kind: 'dir',
    size: rootAgg.size,
    mtimeMs: rootMtime,
    depth: 0,
    ext: null,
    fileCount: rootAgg.fileCount,
    dirCount: rootAgg.dirCount,
  });

  return {
    added,
    updated,
    removed,
    total: walked.length,
    totalBytes: rootAgg.size,
    durationMs: Date.now() - t0,
    truncated,
  };
}
