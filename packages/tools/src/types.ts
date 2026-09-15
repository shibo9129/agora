/** Unified tool (skill / MCP server) view types. */

/** Where a skill's files physically live. */
export interface SkillLocation {
  /** Agent adapter id ('claude-code', 'codex', 'shared-pool', ...). */
  agent: string;
  /** Absolute path of the skill directory. */
  path: string;
  /** 'real' = actual files; 'link' = symlink to a location elsewhere. */
  kind: 'real' | 'link';
  /** For links: resolved symlink target (may be broken). */
  linkTarget?: string;
  /** For links: whether the target exists. */
  linkOk?: boolean;
}

export interface UnifiedSkill {
  /** From SKILL.md frontmatter `name`, or directory name as fallback. */
  name: string;
  description?: string;
  origin?: string;
  /** All locations this skill appears in, keyed by agent. */
  locations: SkillLocation[];
  /** Location holding the real files (the source of truth for linking). */
  realLocation?: SkillLocation | undefined;
}

export type McpServerSpec = {
  type?: 'local' | 'remote';
  command?: string[];
  url?: string;
  enabled?: boolean;
  /** Raw vendor-specific extras preserved verbatim. */
  raw: Record<string, unknown>;
};

export interface McpRegistration {
  agent: string;
  configPath: string;
  /** Server name as written in the config table. */
  serverName: string;
  spec: McpServerSpec;
}

export interface UnifiedMcpServer {
  name: string;
  registrations: McpRegistration[];
  /** Normalized signature for drift detection (command/url redacted). */
  signature: string;
  /** True when ≥2 registrations disagree on the signature. */
  drift: boolean;
}

export type HealthIssueKind = 'mcp-drift' | 'broken-skill-link' | 'declared-missing' | 'duplicate-skill-real';

export interface HealthIssue {
  kind: HealthIssueKind;
  severity: 'warn' | 'error';
  message: string;
  detail?: string;
}

export interface RegistryServer {
  name: string;
  description?: string;
  version?: string;
  /** Extracted install hint: npm package, pypi package, or remote url. */
  packages?: readonly unknown[];
  remotes?: readonly unknown[];
}
