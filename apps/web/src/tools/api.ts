/** Tool center API client. */

import type { AgentDetection } from '../api';

export type { AgentDetection };

export interface SkillLocation {
  agent: string;
  path: string;
  kind: 'real' | 'link';
  linkTarget?: string;
  linkOk?: boolean;
}

export interface UnifiedSkill {
  name: string;
  description?: string;
  origin?: string;
  locations: SkillLocation[];
  realLocation?: SkillLocation;
}

export interface McpServerSpec {
  type?: 'local' | 'remote';
  command?: string[];
  url?: string;
  enabled?: boolean;
  raw: Record<string, unknown>;
}

export interface McpRegistration {
  agent: string;
  configPath: string;
  serverName: string;
  spec: McpServerSpec;
  /** This registration's own signature — differs from the server's on drift. */
  signature: string;
}

export interface UnifiedMcpServer {
  name: string;
  registrations: McpRegistration[];
  signature: string;
  drift: boolean;
}

export interface HealthIssue {
  kind: string;
  severity: 'warn' | 'error';
  message: string;
  detail?: string;
  why?: string;
  fix?: string;
  subject?: string;
  paths?: string[];
}

export interface BrokenSkillLink {
  skill: string;
  agent: string;
  path: string;
  target: string;
}

export interface UnifyResult {
  server: string;
  sourceAgent: string;
  signature: string;
  updated: { agent: string; action: string; configPath: string; backupPath?: string }[];
  skipped: { agent: string; reason: string }[];
}

export type SkillSource =
  | { type: 'git'; url: string; subdir?: string }
  | { type: 'local'; path: string };

export interface InstalledSkill {
  name: string;
  source: SkillSource;
  stamp: string;
  installedAt: string;
  updatedAt: string;
}

export interface UpdateStatus {
  name: string;
  source: SkillSource;
  currentStamp: string;
  remoteStamp?: string;
  updateAvailable: boolean;
  error?: string;
}

export interface InstallResult {
  installed: InstalledSkill[];
  linkedTo: { skill: string; agent: string; action: string }[];
  skipped: { dir: string; reason: string }[];
}

export interface RegistryServer {
  name: string;
  description?: string;
  version?: string;
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

export const toolsApi = {
  agents: () => req<{ agents: AgentDetection[] }>('/api/agents'),
  skills: () => req<{ skills: UnifiedSkill[] }>('/api/tools/skills'),
  toggleSkill: (name: string, agent: string, enable: boolean) =>
    req<{ action: string; detail: string }>(`/api/tools/skills/${encodeURIComponent(name)}/toggle`, json({ agent, enable })),
  brokenLinks: () => req<{ links: BrokenSkillLink[] }>('/api/tools/skills/broken-links'),
  pruneSkills: () => req<{ removed: string[] }>('/api/tools/skills/prune', { method: 'POST' }),
  installed: () => req<{ installed: InstalledSkill[] }>('/api/tools/skills/installed'),
  installSkill: (source: SkillSource, linkTo: string[]) =>
    req<InstallResult>('/api/tools/skills/install', json({ source, linkTo })),
  checkUpdates: () => req<{ statuses: UpdateStatus[] }>('/api/tools/skills/check-updates', { method: 'POST' }),
  updateSkill: (name: string) => req<InstallResult>('/api/tools/skills/update', json({ name })),
  uninstallSkill: (name: string) =>
    req<{ unlinked: string[]; removed: boolean; cleanupErrors: {path: string; error: string}[] }>('/api/tools/skills/uninstall', json({ name })),
  mcp: () => req<{ servers: UnifiedMcpServer[] }>('/api/tools/mcp'),
  toggleMcp: (name: string, agent: string, enable: boolean) =>
    req<{ action: string; configPath: string; backupPath?: string }>(
      `/api/tools/mcp/${encodeURIComponent(name)}/toggle`,
      json({ agent, enable }),
    ),
  unifyMcp: (name: string, sourceAgent: string) =>
    req<UnifyResult>(`/api/tools/mcp/${encodeURIComponent(name)}/unify`, json({ sourceAgent })),
  registry: (q: string) => req<{ servers: RegistryServer[] }>(`/api/tools/mcp/registry?q=${encodeURIComponent(q)}`),
  installMcp: (agent: string, server: RegistryServer) => req<{ action: string }>('/api/tools/mcp/install', json({ agent, server })),
  health: () => req<{ issues: HealthIssue[] }>('/api/tools/health'),
};
