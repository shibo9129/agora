/**
 * Knowledge base registry + schema migration.
 * Shares the single hub database (`agora.db`) with the usage package.
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { KbStats, KnowledgeBase, KnowledgeBaseWithStats, UndoRecord } from './types.js';

export function migrateKnowledge(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      template TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_scanned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS kb_entries (
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file','dir')),
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      ext TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      dir_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (kb_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_entries_depth ON kb_entries(kb_id, depth);

    CREATE TABLE IF NOT EXISTS kb_undo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      moves TEXT NOT NULL,
      undone_at TEXT
    );
  `);

  // FTS table (trigram: substring-friendly, works for CJK ≥3 chars).
  const hasFts = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_fts'`)
    .get();
  if (!hasFts) {
    db.exec(`CREATE VIRTUAL TABLE kb_fts USING fts5(kb_id UNINDEXED, path UNINDEXED, name, tokenize='trigram')`);
  }

  // Column migrations for existing databases (idempotent).
  const entryCols = new Set(
    (db.prepare(`PRAGMA table_info(kb_entries)`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!entryCols.has('file_count')) db.exec(`ALTER TABLE kb_entries ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0`);
  if (!entryCols.has('dir_count')) db.exec(`ALTER TABLE kb_entries ADD COLUMN dir_count INTEGER NOT NULL DEFAULT 0`);
}

interface KbRow {
  id: string;
  name: string;
  root_path: string;
  template: string | null;
  created_at: string;
  last_scanned_at: string | null;
}

function rowToKb(row: KbRow): KnowledgeBase {
  const kb: KnowledgeBase = {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
  };
  if (row.template) kb.template = row.template;
  if (row.last_scanned_at) kb.lastScannedAt = row.last_scanned_at;
  return kb;
}

export function createKb(db: Database.Database, name: string, rootPath: string, template?: string): KnowledgeBase {
  const id = `kb_${randomBytes(6).toString('hex')}`;
  db.prepare('INSERT INTO knowledge_bases (id, name, root_path, template) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    rootPath,
    template ?? null,
  );
  return getKb(db, id)!;
}

export function getKb(db: Database.Database, id: string): KnowledgeBase | null {
  const row = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as KbRow | undefined;
  return row ? rowToKb(row) : null;
}

export function getKbByPath(db: Database.Database, rootPath: string): KnowledgeBase | null {
  const row = db.prepare('SELECT * FROM knowledge_bases WHERE root_path = ?').get(rootPath) as KbRow | undefined;
  return row ? rowToKb(row) : null;
}

export function listKbs(db: Database.Database): KnowledgeBaseWithStats[] {
  const rows = db
    .prepare(
      `SELECT k.*,
              COALESCE(SUM(CASE WHEN e.kind = 'file' THEN 1 ELSE 0 END), 0) AS file_count,
              COALESCE(SUM(CASE WHEN e.kind = 'dir' AND e.path != '' THEN 1 ELSE 0 END), 0) AS dir_count,
              COALESCE((SELECT size FROM kb_entries WHERE kb_id = k.id AND path = ''), 0) AS total_bytes
         FROM knowledge_bases k
         LEFT JOIN kb_entries e ON e.kb_id = k.id
        GROUP BY k.id
        ORDER BY k.created_at DESC`,
    )
    .all() as (KbRow & { file_count: number; dir_count: number; total_bytes: number })[];
  return rows.map((row) => ({
    ...rowToKb(row),
    fileCount: row.file_count,
    dirCount: row.dir_count,
    totalBytes: row.total_bytes,
  }));
}

export function renameKb(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE knowledge_bases SET name = ? WHERE id = ?').run(name, id);
}

export function deleteKb(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM kb_fts WHERE kb_id = ?').run(id);
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
}

export function markScanned(db: Database.Database, id: string): void {
  db.prepare(`UPDATE knowledge_bases SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
}

export function kbStats(db: Database.Database, kbId: string): KbStats {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS files,
              SUM(CASE WHEN kind = 'dir' AND path != '' THEN 1 ELSE 0 END) AS dirs,
              COALESCE((SELECT size FROM kb_entries WHERE kb_id = ? AND path = ''), 0) AS bytes
         FROM kb_entries WHERE kb_id = ?`,
    )
    .get(kbId, kbId) as { files: number | null; dirs: number | null; bytes: number };
  return { fileCount: row.files ?? 0, dirCount: row.dirs ?? 0, totalBytes: row.bytes };
}

// ── Undo log ──────────────────────────────────────────────────────────────

export function addUndoRecord(db: Database.Database, kbId: string, movesJson: string): number {
  const info = db.prepare('INSERT INTO kb_undo (kb_id, moves) VALUES (?, ?)').run(kbId, movesJson);
  return Number(info.lastInsertRowid);
}

export function listUndoRecords(db: Database.Database, kbId: string): UndoRecord[] {
  const rows = db
    .prepare('SELECT * FROM kb_undo WHERE kb_id = ? ORDER BY id DESC')
    .all(kbId) as { id: number; kb_id: string; ts: string; moves: string; undone_at: string | null }[];
  return rows.map((r) => {
    const rec: UndoRecord = { id: r.id, kbId: r.kb_id, ts: r.ts, moves: JSON.parse(r.moves) };
    if (r.undone_at) rec.undoneAt = r.undone_at;
    return rec;
  });
}

export function markUndone(db: Database.Database, undoId: number): void {
  db.prepare(`UPDATE kb_undo SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(undoId);
}
