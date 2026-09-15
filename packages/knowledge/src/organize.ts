/**
 * Directory organizer: analyze → propose moves (extension-class buckets) →
 * execute with an undo log. Execution is rename-only, confined to the kb
 * root; conflicts are skipped, never overwritten.
 */

import type Database from 'better-sqlite3';
import { lstat, mkdir, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { safeKbPath } from './paths.js';
import { addUndoRecord, markUndone } from './registry.js';
import type { OrganizeMove, OrganizePlan } from './types.js';

const CATEGORY_BY_EXT: Record<string, string> = {
  md: 'docs', markdown: 'docs', txt: 'docs', pdf: 'docs', doc: 'docs', docx: 'docs', rtf: 'docs', epub: 'docs',
  png: 'images', jpg: 'images', jpeg: 'images', gif: 'images', svg: 'images', webp: 'images', heic: 'images',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', py: 'code', go: 'code', rs: 'code',
  java: 'code', kt: 'code', swift: 'code', c: 'code', cpp: 'code', h: 'code', sh: 'code',
  json: 'data', jsonl: 'data', csv: 'data', tsv: 'data', yaml: 'data', yml: 'data', xml: 'data',
  db: 'data', sqlite: 'data', sqlite3: 'data', sql: 'data',
  zip: 'archives', tar: 'archives', gz: 'archives', tgz: 'archives', xz: 'archives', '7z': 'archives', dmg: 'archives',
  mp4: 'media', mov: 'media', mp3: 'media', wav: 'media', m4a: 'media', flac: 'media',
};

const MIN_FILES_FOR_PLAN = 4;
const MIN_CATEGORY_SIZE = 2;

interface FileRow {
  path: string;
  name: string;
  ext: string | null;
}

/** Propose moving a directory's direct files into `<category>/` buckets. */
export function proposeOrganization(db: Database.Database, kbId: string, subdir = ''): OrganizePlan {
  const prefixDepth = subdir === '' ? 0 : subdir.split('/').length;
  const files = db
    .prepare(
      `SELECT path, name, ext FROM kb_entries
        WHERE kb_id = ? AND kind = 'file' AND depth = ?
          AND (? = '' OR substr(path, 1, length(?) + 1) = ? || '/')`,
    )
    .all(kbId, prefixDepth + 1, subdir, subdir, subdir) as FileRow[];

  const plan: OrganizePlan = { kbId, moves: [], skipped: [] };
  if (files.length < MIN_FILES_FOR_PLAN) {
    plan.skipped.push({ path: subdir || '(root)', reason: `仅 ${files.length} 个文件，不值得整理` });
    return plan;
  }

  const eligible = files.filter(f => {
    if (!protectedPath(f.path)) return true;
    plan.skipped.push({ path: f.path, reason: '受保护的知识库入口或内容' });
    return false;
  });
  const byCategory = new Map<string, FileRow[]>();
  const noCategory: FileRow[] = [];
  for (const f of eligible) {
    const cat = f.ext ? CATEGORY_BY_EXT[f.ext] : undefined;
    if (cat) {
      const list = byCategory.get(cat) ?? [];
      list.push(f);
      byCategory.set(cat, list);
    } else {
      noCategory.push(f);
    }
  }

  if (byCategory.size < 2) {
    plan.skipped.push({ path: subdir || '(root)', reason: '文件类型单一，无需分类' });
    return plan;
  }

  for (const [cat, list] of byCategory) {
    if (list.length < MIN_CATEGORY_SIZE) continue;
    for (const f of list) {
      plan.moves.push({
        from: f.path,
        to: `${subdir ? `${subdir}/` : ''}${cat}/${f.name}`,
        reason: `按类型归入 ${cat}/`,
      });
    }
  }
  for (const f of noCategory) {
    plan.skipped.push({ path: f.path, reason: '无明确类型归属' });
  }
  return plan;
}

export interface ExecuteResult {
  moved: { from: string; to: string }[];
  failed: { from: string; to: string; error: string }[];
  undoId: number | null;
}

function protectedPath(rel: string): boolean {
  return rel.split('/').some(p => /^(?:\.|raw$|01 Raw$|00 Schema$|02 Wiki$|99_Archive$|archive$)/i.test(p)) ||
    /(?:^|\/)(?:AGENTS\.md|WIKI_ONBOARDING\.md|README(?:\.[^/]+)?|index\.md|log\.md|package\.json|.*\.(?:md|markdown))$/i.test(rel);
}

async function moveFile(root: string, from: string, to: string): Promise<void> {
  const source = await safeKbPath(root, from);
  const target = await safeKbPath(root, to);
  if (!(await lstat(source)).isFile()) throw new Error('仅允许移动普通文件');
  await mkdir(dirname(target), { recursive: true });
  await safeKbPath(root, to);
  // link is exclusive: unlike rename it cannot silently overwrite a target.
  await link(source, target);
  try { await unlink(source); } catch (error) { await unlink(target); throw error; }
}

/** Execute selected moves, then log them for undo. Caller rescans afterwards. */
export async function executeMoves(
  db: Database.Database,
  kbId: string,
  rootPath: string,
  moves: OrganizeMove[],
): Promise<ExecuteResult> {
  const result: ExecuteResult = { moved: [], failed: [], undoId: null };
  for (const mv of moves) {
    try {
      if (protectedPath(mv.from) || protectedPath(mv.to)) throw new Error('受保护的知识库入口或内容，不自动移动');
      await moveFile(rootPath, mv.from, mv.to);
      result.moved.push({ from: mv.from, to: mv.to });
    } catch (err) {
      result.failed.push({ from: mv.from, to: mv.to, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.moved.length > 0) {
    const movesJson = JSON.stringify(
      result.moved.map((m) => ({ from: m.from, to: m.to, reason: moves.find((x) => x.from === m.from)?.reason ?? '' })),
    );
    result.undoId = addUndoRecord(db, kbId, movesJson);
  }
  return result;
}

/** Reverse a previous executeMoves batch (reverse order, files only). */
export async function undoMoves(
  db: Database.Database,
  rootPath: string,
  undoId: number,
  moves: OrganizeMove[],
): Promise<ExecuteResult> {
  const reversed = [...moves].reverse().map((m) => ({ from: m.to, to: m.from, reason: '撤销' }));
  const result: ExecuteResult = { moved: [], failed: [], undoId: null };
  for (const mv of reversed) {
    try {
      await moveFile(rootPath, mv.from, mv.to);
      result.moved.push({ from: mv.from, to: mv.to });
    } catch (err) {
      result.failed.push({ from: mv.from, to: mv.to, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (result.failed.length === 0) markUndone(db, undoId);
  else db.prepare('UPDATE kb_undo SET moves = ? WHERE id = ?').run(JSON.stringify(moves.filter(m => result.failed.some(f => f.from === m.to && f.to === m.from))), undoId);
  return result;
}
