/** Memory + hub API client. */

export interface MemoryEntry {
  path: string;
  scope: string;
  group: string;
  name: string;
  abstract: string;
  type: string;
  by?: string;
  updatedAt: string;
  size: number;
}

export interface MemoryDocument extends MemoryEntry {
  body: string;
}

export interface MemoryGroup {
  scope: string;
  group: string;
  count: number;
}

export interface HubAgentStatus {
  agent: string;
  displayName: string;
  mcpRegistered: boolean;
  /** Registered, but pointing at a different hub than this one — it will fail. */
  mcpStale?: boolean;
  /** What the agent's config currently launches. */
  mcpCommand?: string;
  entryBlockPresent: boolean;
  entryFilePath?: string;
  enrollable: boolean;
}

export interface MemoryConfig {
  rootPath: string;
  defaultRoot: string;
  autoSync: boolean;
  syncIntervalMinutes: number;
  autoEnroll: boolean;
}

export interface AgentSyncStat {
  agent: string;
  found: number;
  synced: number;
  skipped: { path: string; reason: string }[];
}

export interface SyncReport {
  agents: AgentSyncStat[];
  totalSynced: number;
  syncedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...init?.headers, 'X-Agora-Request': '1' } });
  const text = await res.text();
  let body: T & { error?: string };
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(res.ok ? `${path}: 无效响应` : `${path}: ${res.status}`);
  }
  if (!res.ok) throw new Error(body.error ?? `${path}: ${res.status}`);
  return body;
}

const json = (body: unknown, method: RequestInit['method'] = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const memoryApi = {
  entries: (scope?: string, group?: string) =>
    req<{ entries: MemoryEntry[] }>(
      `/api/memory/entries${scope ? `?scope=${encodeURIComponent(scope)}${group ? `&group=${encodeURIComponent(group)}` : ''}` : ''}`,
    ),
  groups: () => req<{ groups: MemoryGroup[] }>('/api/memory/groups'),
  search: (q: string) => req<{ hits: MemoryEntry[] }>(`/api/memory/search?q=${encodeURIComponent(q)}`),
  read: (path: string) => req<MemoryDocument>(`/api/memory/entry?path=${encodeURIComponent(path)}`),
  write: (input: { name: string; abstract: string; body: string; scope?: string; group?: string; type?: string }) =>
    req<{ entry: MemoryEntry }>('/api/memory/entries', json(input)),
  remove: (path: string) => req<{ ok: boolean }>(`/api/memory/entry?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  reindex: () => req<{ indexed: number }>('/api/memory/reindex', { method: 'POST' }),
  hubStatus: () => req<{ agents: HubAgentStatus[] }>('/api/hub/status'),
  enroll: (agent: string) => req<unknown>('/api/hub/enroll', json({ agent })),
  unenroll: (agent: string) => req<unknown>('/api/hub/unenroll', json({ agent })),
  config: () => req<MemoryConfig>('/api/memory/config'),
  saveConfig: (input: { rootPath?: string; autoSync?: boolean; syncIntervalMinutes?: number; autoEnroll?: boolean }) =>
    req<{ rootPath: string; autoSync: boolean; syncIntervalMinutes: number; autoEnroll: boolean }>(
      '/api/memory/config',
      json(input, 'PUT'),
    ),
  sync: () => req<SyncReport>('/api/memory/sync', { method: 'POST' }),
};
