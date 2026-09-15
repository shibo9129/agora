/** Memory domain types: Markdown files are the source of truth. */

export type MemoryScope = 'global' | 'synced' | `project-${string}`;

export interface MemoryEntry {
  revision?: string;
  /** Relative path from memory root, posix, e.g. 'global/notes/agora-design.md'. */
  path: string;
  scope: MemoryScope;
  group: string;
  name: string;
  /** One-line abstract (L0 recall field). */
  abstract: string;
  /** Free-form type tag, e.g. 'decision' | 'fact' | 'preference' | 'note'. */
  type: string;
  /** Agent/user id that wrote the last revision. */
  by?: string;
  updatedAt: string;
  size: number;
}

export interface MemoryDocument extends MemoryEntry {
  /** Full markdown body (without frontmatter). */
  body: string;
}

export interface MemorySearchHit extends MemoryEntry {
  /** bm25 rank (lower is better) when via FTS. */
  rank?: number;
}

export interface MemoryWriteInput {
  expectedUpdatedAt?: string;
  expectedRevision?: string;
  scope?: MemoryScope;
  group?: string;
  name: string;
  abstract: string;
  body: string;
  type?: string;
  by?: string;
}
