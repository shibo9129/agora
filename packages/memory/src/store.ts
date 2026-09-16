/**
 * Memory store: Markdown files are the single source of truth; the SQLite
 * index is a disposable cache (rebuild anytime, zero loss).
 *
 * Layout on disk:
 *   <memoryRoot>/<scope>/<group>/<name>.md     (frontmatter + markdown body)
 *   <memoryRoot>/MEMORY.md                     (auto-maintained L0 root index)
 *
 * Retrieval contract (progressive disclosure):
 *   search() → L0 rows (path + name + abstract + score)
 *   read()   → full document on demand
 */

import Database from 'better-sqlite3';
import matter from 'gray-matter';
import { mkdir, readFile, rm, writeFile, rename, copyFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, lstatSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { MemoryDocument, MemoryEntry, MemoryScope, MemorySearchHit, MemoryWriteInput } from './types.js';

export function migrateMemory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      path TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      grp TEXT NOT NULL,
      name TEXT NOT NULL,
      abstract TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'note',
      by TEXT,
      updated_at TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope, grp);
  `);
  const hasFts = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'`).get();
  if (!hasFts) {
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, name, abstract, body, tokenize='trigram')`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(parts: string[]): string {
  return parts.join('/');
}

function assertSafeSegment(seg: string, what: string): void {
  // Unicode letters/digits allowed (CJK names are first-class); no path
  // separators, no traversal, reasonable length.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,80}$/u.test(seg) || seg.includes('..')) {
    throw new Error(`非法${what}: ${seg}`);
  }
}

function entryFromRow(row: {
  path: string;
  scope: string;
  grp: string;
  name: string;
  abstract: string;
  type: string;
  by: string | null;
  updated_at: string;
  size: number;
}): MemoryEntry {
  const entry: MemoryEntry = {
    path: row.path,
    scope: row.scope as MemoryScope,
    group: row.grp,
    name: row.name,
    abstract: row.abstract,
    type: row.type,
    updatedAt: row.updated_at,
    size: row.size,
  };
  if (row.by) entry.by = row.by;
  return entry;
}

export class MemoryStore {
  constructor(
    private readonly db: Database.Database,
    readonly root: string,
  ) {
    migrateMemory(db);
    this.syncFromDisk();
  }

  private absPath(rel: string): string {
    if (rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
      throw new Error(`路径逃逸拒绝: ${rel}`);
    }
    let current = this.root;
    for (const part of rel.split('/').filter(Boolean)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('记忆路径不允许符号链接'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return current;
  }

  // ── Write path ──────────────────────────────────────────────────────────

  async write(input: MemoryWriteInput): Promise<MemoryEntry> {
    return this.withWriteLock(() => this.writeLocked(input));
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, '.write-lock');
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('记忆正在写入，请重试；异常退出后请核实并清理 .write-lock');
      throw error;
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async atomicFile(path: string, content: string): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } finally { await rm(tmp, { force: true }); }
  }

  private async archive(path: string): Promise<void> {
    if (!existsSync(path)) return;
    const history = this.absPath('.history');
    await mkdir(history, { recursive: true });
    await copyFile(path, join(history, `${Date.now()}-${randomUUID()}.md`));
  }

  private async writeLocked(input: MemoryWriteInput): Promise<MemoryEntry> {
    const scope = input.scope ?? 'global';
    const group = input.group ?? 'notes';
    assertSafeSegment(scope, 'scope');
    assertSafeSegment(group, 'group');
    assertSafeSegment(input.name, 'name');
    const rel = toPosix([scope, group, `${input.name}.md`]);
    const abs = this.absPath(rel);
    const current = this.getEntry(rel);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== (current?.updatedAt ?? '')) throw new Error('记忆已被其他写入更新，请重新读取后合并');
    if (current) {
      const revision = createHash('sha256').update(await readFile(abs)).digest('hex');
      if (input.expectedRevision !== revision) throw new Error('记忆已存在或内容已变化，请重新读取 revision 后合并');
    }
    const updatedAt = nowIso();
    const frontmatter: Record<string, string> = {
      name: input.name,
      abstract: input.abstract,
      type: input.type ?? 'note',
      updated: updatedAt,
    };
    if (input.by) frontmatter['by'] = input.by;
    const fileContent = matter.stringify(`\n${input.body.trim()}\n`, frontmatter);
    await mkdir(dirname(abs), { recursive: true });
    await this.archive(abs);
    await this.atomicFile(abs, fileContent);

    this.db
      .prepare(
        `INSERT INTO memory_entries (path, scope, grp, name, abstract, type, by, updated_at, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           scope=excluded.scope, grp=excluded.grp, name=excluded.name,
           abstract=excluded.abstract, type=excluded.type, by=excluded.by,
           updated_at=excluded.updated_at, size=excluded.size`,
      )
      .run(rel, scope, group, input.name, input.abstract, input.type ?? 'note', input.by ?? null, updatedAt, fileContent.length);
    this.ftsUpsert(rel, input.name, input.abstract, input.body);
    await this.rebuildRootIndex();
    return this.getEntry(rel)!;
  }

  async remove(path: string): Promise<boolean> {
    return this.withWriteLock(() => this.removeLocked(path));
  }

  private async removeLocked(path: string): Promise<boolean> {
    const abs = this.absPath(path);
    await this.archive(abs);
    const existed = this.db.prepare('DELETE FROM memory_entries WHERE path = ?').run(path).changes > 0;
    this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(path);
    if (existsSync(abs)) await rm(abs);
    await this.rebuildRootIndex();
    return existed;
  }

  // ── Read path ───────────────────────────────────────────────────────────

  getEntry(path: string): MemoryEntry | null {
    this.syncFromDisk();
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE path = ?').get(path) as
      | Parameters<typeof entryFromRow>[0]
      | undefined;
    return row ? entryFromRow(row) : null;
  }

  async read(path: string): Promise<MemoryDocument | null> {
    const entry = this.getEntry(path);
    if (!entry) return null;
    try {
      const raw = await readFile(this.absPath(path), 'utf-8');
      const { content } = matter(raw);
      return { ...entry, revision: createHash('sha256').update(raw).digest('hex'), body: content.trim() };
    } catch {
      return null;
    }
  }

  list(scope?: MemoryScope, group?: string, limit = 200): MemoryEntry[] {
    this.syncFromDisk();
    const rows = (
      scope
        ? group
          ? this.db
              .prepare('SELECT * FROM memory_entries WHERE scope = ? AND grp = ? ORDER BY updated_at DESC LIMIT ?')
              .all(scope, group, limit)
        : this.db
            .prepare('SELECT * FROM memory_entries WHERE scope = ? ORDER BY updated_at DESC LIMIT ?')
            .all(scope, limit)
        : this.db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT ?').all(limit)
    ) as Parameters<typeof entryFromRow>[0][];
    return rows.map(entryFromRow);
  }

  groups(scope?: MemoryScope): { scope: string; group: string; count: number }[] {
    this.syncFromDisk();
    const rows = (
      scope
        ? this.db
            .prepare('SELECT scope, grp, COUNT(*) n FROM memory_entries WHERE scope = ? GROUP BY scope, grp ORDER BY grp')
            .all(scope)
        : this.db.prepare('SELECT scope, grp, COUNT(*) n FROM memory_entries GROUP BY scope, grp ORDER BY scope, grp').all()
    ) as { scope: string; grp: string; n: number }[];
    return rows.map((r) => ({ scope: r.scope, group: r.grp, count: r.n }));
  }

  search(query: string, options: { scope?: MemoryScope; limit?: number } = {}): MemorySearchHit[] {
    this.syncFromDisk();
    const q = query.trim();
    if (q.length === 0) return [];
    const limit = options.limit ?? 20;
    if ([...q].length >= 3) {
      const safe = q.replace(/"/g, '""');
      const scopeClause = options.scope ? 'AND e.scope = @scope' : '';
      const rows = this.db
        .prepare(
          `SELECT e.*, fts.rank AS rank FROM memory_fts fts
             JOIN memory_entries e ON e.path = fts.path
            WHERE memory_fts MATCH @q ${scopeClause}
            ORDER BY fts.rank LIMIT @limit`,
        )
        .all({ q: `"${safe}"`, scope: options.scope, limit }) as (Parameters<typeof entryFromRow>[0] & { rank: number })[];
      return rows.map((r) => ({ ...entryFromRow(r), rank: r.rank }));
    }
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const scopeClause = options.scope ? 'AND scope = @scope' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entries WHERE (name LIKE @like ESCAPE '\\' OR abstract LIKE @like ESCAPE '\\')
          ${scopeClause}
         ORDER BY updated_at DESC LIMIT @limit`,
      )
      .all({ like, scope: options.scope, limit }) as Parameters<typeof entryFromRow>[0][];
    return rows.map((r) => entryFromRow(r));
  }

  // ── Index maintenance ───────────────────────────────────────────────────

  private ftsUpsert(path: string, name: string, abstract: string, body: string): void {
    this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(path);
    this.db.prepare('INSERT INTO memory_fts (path, name, abstract, body) VALUES (?, ?, ?, ?)').run(path, name, abstract, body);
  }

  /** Refresh on access: external edits are visible without a background daemon. */
  private syncFromDisk(): number {
    const docs: { rel: string; raw: string; mtime: string }[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        const abs = this.absPath(child);
        if (e.isDirectory()) walk(abs, child);
        else if (e.isFile() && e.name.endsWith('.md') && child !== 'MEMORY.md') docs.push({ rel: child, raw: readFileSync(abs, 'utf8'), mtime: statSync(abs).mtime.toISOString() });
      }
    };
    if (!existsSync(this.root)) return 0;
    walk(this.root, ''); // Fail before changing the index if a directory is unreadable.
    const parsed = docs.map(d => {
      const { data, content } = matter(d.raw);
      const parts = d.rel.split('/');
      return { ...d, content, scope: parts[0] ?? 'global', group: parts.length >= 3 ? parts[1]! : 'notes', name: typeof data['name'] === 'string' ? data['name'] : parts.at(-1)!.replace(/\.md$/, ''), abstract: typeof data['abstract'] === 'string' ? data['abstract'] : '', type: typeof data['type'] === 'string' ? data['type'] : 'note', by: typeof data['by'] === 'string' ? data['by'] : null, updated: typeof data['updated'] === 'string' ? data['updated'] : d.mtime, hash: createHash('sha256').update(d.raw).digest('hex') };
    });
    this.db.exec('CREATE TABLE IF NOT EXISTS memory_file_hashes (path TEXT PRIMARY KEY, hash TEXT NOT NULL)');
    this.db.transaction(() => {
      const seen = new Set(parsed.map(d => d.rel));
      for (const row of this.db.prepare('SELECT path FROM memory_entries').all() as {path:string}[]) {
        if (!seen.has(row.path)) {
          this.db.prepare('DELETE FROM memory_entries WHERE path = ?').run(row.path);
          this.db.prepare('DELETE FROM memory_fts WHERE path = ?').run(row.path);
          this.db.prepare('DELETE FROM memory_file_hashes WHERE path = ?').run(row.path);
        }
      }
      for (const d of parsed) {
        const old = this.db.prepare('SELECT h.hash FROM memory_file_hashes h JOIN memory_entries e ON e.path=h.path WHERE h.path=? AND EXISTS (SELECT 1 FROM memory_fts f WHERE f.path=h.path)').get(d.rel) as {hash:string} | undefined;
        if (old?.hash === d.hash) continue;
        this.db.prepare('INSERT OR REPLACE INTO memory_entries (path, scope, grp, name, abstract, type, by, updated_at, size) VALUES (?,?,?,?,?,?,?,?,?)').run(d.rel, d.scope, d.group, d.name, d.abstract, d.type, d.by, d.updated, Buffer.byteLength(d.raw));
        this.ftsUpsert(d.rel, d.name, d.abstract, d.content);
        this.db.prepare('INSERT OR REPLACE INTO memory_file_hashes VALUES (?,?)').run(d.rel, d.hash);
      }
    })();
    return parsed.length;
  }

  async reindex(): Promise<{ indexed: number }> {
    const indexed = this.syncFromDisk();
    await this.rebuildRootIndex();
    return { indexed };
  }

  /** MEMORY.md: the always-injected L0 root index (grouped one-liners). */
  async rebuildRootIndex(): Promise<void> {
    const groups = this.groups();
    const lines: string[] = [
      '# MEMORY',
      '',
      '> 由 Agora 自动维护的全局记忆根索引。逐条全文用 memory_read 按需展开。',
      '',
    ];
    let lastScope = '';
    for (const g of groups) {
      if (g.scope !== lastScope) {
        lines.push(`## [${g.scope}]`, '');
        lastScope = g.scope;
      }
      const entries = this.list(g.scope as MemoryScope, g.group, 12);
      lines.push(`### ${g.group}（${g.count}）`);
      for (const e of entries) {
        lines.push(`- \`${e.path}\` — ${e.abstract || e.name}`);
      }
      lines.push('');
    }
    if (groups.length === 0) lines.push('（空）', '');
    await mkdir(this.root, { recursive: true });
    // When the root points at an EXISTING library (e.g. a user's vault), its
    // MEMORY.md may not be ours — back it up before overwriting, honoring
    // the "only touch files Agora manages" contract.
    const rootIndexPath = this.absPath('MEMORY.md');
    if (existsSync(rootIndexPath)) {
      try {
        const existing = await readFile(rootIndexPath, 'utf-8');
        if (!existing.includes('由 Agora 自动维护')) {
          await copyFile(rootIndexPath, `${rootIndexPath}.agora-bak-${Date.now()}`);
        }
      } catch {
        // unreadable — the atomic write below will surface any real error
      }
    }
    await this.atomicFile(rootIndexPath, lines.join('\n'));
  }
}
