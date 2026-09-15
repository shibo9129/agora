/** Knowledge base API client. */

export interface KnowledgeBase {
  id: string;
  name: string;
  rootPath: string;
  template?: string;
  createdAt: string;
  lastScannedAt?: string;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

export interface KbTemplate {
  id: string;
  name: string;
  description: string;
  dirs: readonly string[];
}

export interface TreemapNode {
  kind?: 'file' | 'dir';
  name: string;
  path: string;
  size: number;
  fileCount: number;
  dirCount: number;
  children?: TreemapNode[];
}

export interface KbEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  depth: number;
  ext: string | null;
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...init?.headers, 'X-Agora-Request': '1' } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${path}: ${res.status}`);
  return body;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const kbApi = {
  templates: () => req<{ templates: KbTemplate[] }>('/api/kb/templates'),
  list: () => req<{ kbs: KnowledgeBase[] }>('/api/kb'),
  register: (name: string, rootPath: string) => req<{ kb: KnowledgeBase }>('/api/kb', json({ name, rootPath })),
  create: (name: string, rootPath: string, templateId: string) =>
    req<{ kb: KnowledgeBase }>('/api/kb/create', json({ name, rootPath, templateId })),
  remove: (id: string) => req<{ ok: boolean }>(`/api/kb/${id}`, { method: 'DELETE' }),
  scan: (id: string) => req<{ total: number; totalBytes: number; durationMs: number }>(`/api/kb/${id}/scan`, { method: 'POST' }),
  treemap: (id: string, path = '', depth = 4) => req<TreemapNode>(`/api/kb/${id}/treemap?path=${encodeURIComponent(path)}&depth=${depth}`),
  entries: (id: string, path = '') => req<{ entries: KbEntry[] }>(`/api/kb/${id}/entries?path=${encodeURIComponent(path)}`),
  search: (id: string, q: string) => req<{ hits: SearchHit[] }>(`/api/kb/${id}/search?q=${encodeURIComponent(q)}`),
  open: (id: string, path: string) => req<{ ok: boolean }>(`/api/kb/${id}/open`, json({ path })),
  propose: (id: string, subdir = '') => req<OrganizePlan>(`/api/kb/${id}/organize/propose`, json({ subdir })),
  undos: (id: string) => req<{ records: { id: number; ts: string; undoneAt?: string; moves: OrganizeMove[] }[] }>(`/api/kb/${id}/undo`),
  undo: (id: string, undoId: number) => req<{ moved: OrganizeMove[]; failed: { error: string }[] }>(`/api/kb/${id}/organize/undo`, json({ undoId })),
  execute: (id: string, moves: OrganizeMove[]) =>
    req<{ moved: { from: string; to: string }[]; failed: { from: string; to: string; error: string }[] }>(
      `/api/kb/${id}/organize/execute`,
      json({ moves }),
    ),
};

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}
