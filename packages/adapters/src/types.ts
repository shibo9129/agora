/**
 * Agent adapter contract.
 *
 * An adapter is the single source of knowledge about one agent harness:
 * where its config lives, where its skills/MCP servers are declared, and
 * how to detect its presence on this machine. Milestone M1 uses only
 * detection + identity; skills/MCP/entry-file capabilities land in M3/M4.
 */

export interface AgentAdapter {
  /** Stable id, e.g. 'claude-code'. Also used as the usage collector's agent id. */
  readonly id: string;
  readonly displayName: string;
  readonly category: 'cli' | 'desktop' | 'daemon';
  /** Files this agent reads as its "entry" instructions (AGENTS.md style). */
  readonly entryFiles: readonly string[];
  detect(env?: AdapterEnv): Promise<AgentDetection>;
  /** Directories scanned for skills (frontmatter SKILL.md), in priority order. */
  skillDirs?(env?: AdapterEnv): string[];
  /** Directories holding this agent's memory files (.md), for hub sync. */
  memoryDirs?(env?: AdapterEnv): string[];
  /** MCP server config location + format, when this agent has one. */
  mcpConfig?(env?: AdapterEnv): McpConfigRef | null;
  /** Whether Agora can WRITE this agent's MCP config (jsonc/toml editors). */
  readonly mcpWritable?: boolean;
}

export interface McpConfigRef {
  path: string;
  format: 'jsonc' | 'toml' | 'yaml' | 'json';
}

export interface AdapterEnv {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentDetection {
  id: string;
  displayName: string;
  category: AgentAdapter['category'];
  /** True when the agent's home directory exists on this machine. */
  installed: boolean;
  /** Resolved config home (may not exist when installed === false). */
  configHome: string;
  entryFiles: readonly string[];
  /** Free-form detail for the UI (e.g. version, config file found). */
  detail?: string;
  /**
   * 'virtual' marks non-agent locations (shared skill pool, Agora store)
   * that participate in skill matrices but are not real AI agents.
   */
  kind?: 'agent' | 'virtual';
  /**
   * Presence verdict beyond a bare config-dir check:
   * - 'installed': the app/CLI/daemon itself is present (bin/app/process).
   * - 'residual': config leftovers exist but the app itself is gone
   *   (uninstalled or never installed on this machine).
   * - 'absent': nothing found.
   */
  presence?: 'installed' | 'residual' | 'absent';
  /** True when this adapter declares skill dirs (can receive skill links). */
  supportsSkills?: boolean;
  /** True when this adapter declares memory dirs (can feed memory sync). */
  supportsMemorySync?: boolean;
  /** True when Agora can write this agent's MCP config file. */
  mcpWritable?: boolean;
}
