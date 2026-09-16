/** API client for the agora server (same origin in prod, vite proxy in dev). */

export interface UsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUSD: number;
  calls: number;
}

export interface AgentBreakdown extends UsageTotals {
  agent: string;
}
export interface ModelBreakdown extends UsageTotals {
  model: string;
  agent: string;
}
export interface ProjectBreakdown extends UsageTotals {
  project: string;
}
export interface DailyUsage extends UsageTotals {
  day: string;
  agent: string;
}

export interface HourlyUsage extends UsageTotals {
  /** Local hour of today, zero-padded '00'..'23'. */
  hour: string;
  agent: string;
}

export interface AgentDetection {
  id: string;
  displayName: string;
  category: string;
  installed: boolean;
  configHome: string;
  entryFiles: readonly string[];
  detail?: string;
  /** 'installed' | 'residual' (config leftovers, app gone) | 'absent'. */
  presence?: 'installed' | 'residual' | 'absent';
  /** Adapter declares skill dirs (can receive skill links). */
  supportsSkills?: boolean;
  /** Adapter declares memory dirs (can feed memory sync). */
  supportsMemorySync?: boolean;
  /** Agora can write this agent's MCP config. */
  mcpWritable?: boolean;
}

export interface CollectionReport {
  startedAt: string;
  finishedAt: string;
  sources: {
    agent: string;
    sourcePath: string;
    status: 'collected' | 'unchanged' | 'failed';
    parsed: number;
    inserted: number;
    duplicates: number;
    error?: string;
  }[];
  totals: { parsed: number; inserted: number; duplicates: number; failed: number };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  summary: (days?: number) => get<UsageTotals>(`/api/usage/summary${days ? `?days=${days}` : ''}`),
  byAgent: (days?: number) => get<{ rows: AgentBreakdown[] }>(`/api/usage/by-agent${days ? `?days=${days}` : ''}`),
  byModel: (days?: number) => get<{ rows: ModelBreakdown[] }>(`/api/usage/by-model${days ? `?days=${days}` : ''}`),
  byProject: (days?: number) => get<{ rows: ProjectBreakdown[] }>(`/api/usage/by-project${days ? `?days=${days}` : ''}`),
  daily: (days = 30) => get<{ rows: DailyUsage[] }>(`/api/usage/daily?days=${days}`),
  hourly: () => get<{ rows: HourlyUsage[] }>('/api/usage/hourly'),
  agents: () => get<{ agents: AgentDetection[] }>('/api/agents'),
  collect: async (): Promise<CollectionReport> => {
    const res = await fetch('/api/collect', { method: 'POST', headers: { 'X-Agora-Request': '1' } });
    if (!res.ok) throw new Error(`collect: ${res.status}`);
    return res.json() as Promise<CollectionReport>;
  },
};

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatUSD(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  hermes: 'Hermes',
  pi: 'Pi',
};

export const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#d97757',
  codex: '#10a37f',
  opencode: '#6366f1',
  'gemini-cli': '#4285f4',
  hermes: '#f59e0b',
  pi: '#ec4899',
};
