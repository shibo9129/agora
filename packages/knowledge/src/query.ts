/**
 * Treemap + name-search queries over indexed kb entries.
 * Directory sizes are pre-aggregated at scan time; these queries are O(rows
 * under prefix) and safe to run per UI interaction.
 */

import type Database from 'better-sqlite3';

import type { SearchHit, TreemapNode } from './types.js';

interface EntryRow {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  depth: number;
  ext: string | null;
  file_count: number;
  dir_count: number;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Build a treemap payload for `prefix` (relative posix path, '' = root),
 * expanding directories up to `maxDepth` levels below the prefix.
 * Sizes and file/dir counts are pre-aggregated at scan time.
 * Children beyond `topN` per directory are merged into an "(其他)" bucket.
 */
export function queryTreemap(
  db: Database.Database,
  kbId: string,
  prefix = '',
  maxDepth = 4,
  topN = 24,
): TreemapNode | null {
  const prefixDepth = prefix === '' ? 0 : prefix.split('/').length;
  const rows = db
    .prepare(
      `SELECT path, name, kind, size, depth, ext, file_count, dir_count FROM kb_entries
        WHERE kb_id = ? AND depth > ? AND depth <= ?
          AND (? = '' OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
        ORDER BY depth, size DESC`,
    )
    .all(kbId, prefixDepth, prefixDepth + maxDepth, prefix, prefix, prefix, prefix) as EntryRow[];

  const rootRow = db
    .prepare('SELECT path, name, kind, size, depth, ext, file_count, dir_count FROM kb_entries WHERE kb_id = ? AND path = ?')
    .get(kbId, prefix) as EntryRow | undefined;
  if (!rootRow) return null;

  interface MutableNode extends TreemapNode {
    children: MutableNode[];
  }
  const toNode = (row: EntryRow): MutableNode => ({
    kind: row.kind,
    name: row.name,
    path: row.path,
    size: row.size,
    fileCount: row.kind === 'file' ? 1 : row.file_count,
    dirCount: row.dir_count,
    children: [],
  });
  const nodes = new Map<string, MutableNode>();
  const root = toNode(rootRow);
  nodes.set(prefix, root);

  for (const row of rows) {
    const node = toNode(row);
    nodes.set(row.path, node);
    nodes.get(parentOf(row.path))?.children.push(node);
  }
  // Root's own counts include direct + nested (accumulated above).
  // Prune: keep topN children by size, merge the rest into "(其他)".
  const prune = (node: MutableNode): TreemapNode => {
    let children = node.children;
    if (children.length > topN) {
      const kept = children.slice(0, topN);
      const rest = children.slice(topN);
      const restSize = rest.reduce((s, c) => s + c.size, 0);
      const restFiles = rest.reduce((s, c) => s + c.fileCount, 0);
      const restDirs = rest.reduce((s, c) => s + c.dirCount, 0);
      if (restSize > 0) {
        kept.push({
          kind: 'dir',
          name: `(其他 ${rest.length} 项)`,
          path: node.path,
          size: restSize,
          fileCount: restFiles,
          dirCount: restDirs,
          children: [],
        });
      }
      children = kept;
    }
    const out: TreemapNode = {
      ...(node.kind ? { kind: node.kind } : {}),
      name: node.name,
      path: node.path,
      size: node.size,
      fileCount: node.fileCount,
      dirCount: node.dirCount,
    };
    const pruned = children.filter((c) => c.size > 0 || c.fileCount > 0).map(prune);
    if (pruned.length > 0) out.children = pruned;
    return out;
  };
  return prune(root);
}

/** Name search: FTS5 trigram for ≥3 chars, LIKE fallback for shorter queries. */
export function searchKb(db: Database.Database, kbId: string, query: string, limit = 50): SearchHit[] {
  const q = query.trim();
  if (q.length === 0) return [];
  if ([...q].length >= 3) {
    // FTS trigram path (name is the only indexed column).
    const safe = q.replace(/"/g, '""');
    return db
      .prepare(
        `SELECT e.path, e.name, e.kind, e.size
           FROM kb_fts f JOIN kb_entries e ON e.kb_id = f.kb_id AND e.path = f.path
          WHERE f.kb_id = ? AND kb_fts MATCH '"${safe}"'
          ORDER BY e.size DESC LIMIT ?`,
      )
      .all(kbId, limit) as SearchHit[];
  }
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return db
    .prepare(
      `SELECT path, name, kind, size FROM kb_entries
        WHERE kb_id = ? AND name LIKE ? ESCAPE '\\' AND path != ''
        ORDER BY size DESC LIMIT ?`,
    )
    .all(kbId, like, limit) as SearchHit[];
}
