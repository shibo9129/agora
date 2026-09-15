/** Knowledge base domain types. */

export interface KnowledgeBase {
  id: string;
  name: string;
  /** Absolute root path on this machine. */
  rootPath: string;
  /** Template id it was created from, if any. */
  template?: string;
  createdAt: string;
  lastScannedAt?: string;
}

export interface KbStats {
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

export interface KnowledgeBaseWithStats extends KnowledgeBase, KbStats {}

export interface KbEntry {
  kbId: string;
  /** Path relative to kb root, posix separators, no leading slash. '' = root. */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  /** For dirs: recursive aggregate size of descendants. */
  size: number;
  mtimeMs: number;
  depth: number;
  ext?: string;
  /** Recursive descendant counts (dirs include all nested dirs). */
  fileCount?: number;
  dirCount?: number;
}

/** A node in the treemap payload (sizes pre-aggregated server-side). */
export interface TreemapNode {
  kind?: 'file' | 'dir';
  name: string;
  path: string;
  size: number;
  fileCount: number;
  dirCount: number;
  children?: TreemapNode[];
}

export interface SearchHit {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
}

export interface OrganizeMove {
  from: string;
  to: string;
  reason: string;
}

export interface OrganizePlan {
  kbId: string;
  moves: OrganizeMove[];
  skipped: { path: string; reason: string }[];
}

export interface UndoRecord {
  id: number;
  kbId: string;
  ts: string;
  moves: OrganizeMove[];
  undoneAt?: string;
}

export interface KbTemplate {
  id: string;
  name: string;
  description: string;
  /** Directories to create (relative, posix). */
  dirs: readonly string[];
  /** Seed files with initial content. */
  files: readonly { path: string; content: string }[];
}
