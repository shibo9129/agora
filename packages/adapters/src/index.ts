import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AdapterEnv, AgentAdapter, AgentDetection, McpConfigRef } from './types.js';

export * from './types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function home(env?: AdapterEnv): string {
  return env?.home ?? homedir();
}

function environ(env?: AdapterEnv): NodeJS.ProcessEnv {
  return env?.env ?? process.env;
}

function makeAdapter(def: {
  id: string;
  displayName: string;
  category: AgentAdapter['category'];
  entryFiles: readonly string[];
  configHome: (env?: AdapterEnv) => string;
  detectDetail?: (configHome: string, env?: AdapterEnv) => Promise<string | undefined>;
  /** Extra proof that the app itself (not just its config dir) is present:
   *  CLI binary names (checked on PATH) and/or macOS .app bundle paths. */
  presenceProof?: (env?: AdapterEnv) => Promise<boolean>;
  skillDirs?: (env?: AdapterEnv) => string[];
  memoryDirs?: (env?: AdapterEnv) => string[];
  mcpConfig?: (env?: AdapterEnv) => McpConfigRef | null;
  mcpWritable?: boolean;
  /** 'virtual' for non-agent locations (shared pool, store). Default 'agent'. */
  kind?: 'agent' | 'virtual';
}): AgentAdapter {
  const adapter: AgentAdapter = {
    id: def.id,
    displayName: def.displayName,
    category: def.category,
    entryFiles: def.entryFiles,
    ...(def.mcpWritable !== undefined ? { mcpWritable: def.mcpWritable } : {}),
    ...(def.skillDirs ? { skillDirs: def.skillDirs } : {}),
    ...(def.memoryDirs ? { memoryDirs: def.memoryDirs } : {}),
    ...(def.mcpConfig ? { mcpConfig: def.mcpConfig } : {}),
    async detect(adapterEnv?: AdapterEnv): Promise<AgentDetection> {
      const configHome = def.configHome(adapterEnv);
      const dirExists = await exists(configHome);
      const appPresent = def.presenceProof ? await def.presenceProof(adapterEnv) : dirExists;
      const installed = dirExists && appPresent;
      const detail = installed && def.detectDetail ? await def.detectDetail(configHome, adapterEnv) : undefined;
      const detection: AgentDetection = {
        id: def.id,
        displayName: def.displayName,
        category: def.category,
        installed,
        configHome,
        entryFiles: def.entryFiles,
        presence: installed ? 'installed' : dirExists ? 'residual' : 'absent',
        supportsSkills: def.skillDirs !== undefined,
        supportsMemorySync: def.memoryDirs !== undefined,
        mcpWritable: def.mcpWritable === true,
      };
      if (detail !== undefined) detection.detail = detail;
      if (def.kind !== undefined) detection.kind = def.kind;
      return detection;
    },
  };
  return adapter;
}

/** Find a CLI binary on PATH (posix `which` semantics, no shell), then fall
 *  back to well-known install locations — desktop apps launched from Finder
 *  get a minimal PATH that misses most CLI tools. */
export async function whichBin(name: string, env?: AdapterEnv): Promise<string | null> {
  const home = env?.home ?? homedir();
  const pathEnv = (env?.env ?? process.env)['PATH'] ?? '';
  const candidates: string[] = [];
  for (const dir of pathEnv.split(':')) {
    if (dir) candidates.push(join(dir, name));
  }
  for (const dir of WELL_KNOWN_BIN_DIRS) {
    candidates.push(join(dir.replace(/^~/, home), name));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

const WELL_KNOWN_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '~/bin',
  '~/.local/bin',
  '~/.hermes/node/bin',
  '~/.grok/bin',
  '~/.kimi-code/bin',
  '~/.npm-global/bin',
  '~/.bun/bin',
  '~/.volta/bin',
  '~/.nvm/current/bin',
];

export const claudeCodeAdapter = makeAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  category: 'cli',
  entryFiles: ['CLAUDE.md', 'AGENTS.md'],
  configHome: (e) => environ(e)['CLAUDE_CONFIG_DIR'] ?? join(home(e), '.claude'),
  presenceProof: async (e) => (await whichBin('claude', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
  skillDirs: (e) => [join(environ(e)['CLAUDE_CONFIG_DIR'] ?? join(home(e), '.claude'), 'skills')],
  memoryDirs: (e) => [join(environ(e)['CLAUDE_CONFIG_DIR'] ?? join(home(e), '.claude'), 'memory')],
  mcpConfig: (e) => ({ path: join(home(e), '.claude.json'), format: 'json' }),
  mcpWritable: true,
});

export const codexAdapter = makeAdapter({
  id: 'codex',
  displayName: 'Codex',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => environ(e)['CODEX_HOME'] ?? join(home(e), '.codex'),
  presenceProof: async (e) => (await whichBin('codex', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'config.toml'))) ? 'config.toml found' : undefined),
  skillDirs: (e) => [join(environ(e)['CODEX_HOME'] ?? join(home(e), '.codex'), 'skills')],
  memoryDirs: (e) => [join(environ(e)['CODEX_HOME'] ?? join(home(e), '.codex'), 'memories')],
  mcpConfig: (e) => ({ path: join(environ(e)['CODEX_HOME'] ?? join(home(e), '.codex'), 'config.toml'), format: 'toml' }),
  mcpWritable: true,
});

export const opencodeAdapter = makeAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'opencode'),
  presenceProof: async (e) => (await whichBin('opencode', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'opencode.jsonc'))) ? 'opencode.jsonc found' : undefined),
  // OpenCode auto-loads external skills beyond its own dir (from its binary:
  // "External skills (auto-loaded): ~/.claude/skills, ~/.agents/skills").
  // Its own dir stays first so toggles write there, never into shared dirs.
  skillDirs: (e) => [
    join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'opencode', 'skills'),
    join(home(e), '.agents', 'skills'),
    join(environ(e)['CLAUDE_CONFIG_DIR'] ?? join(home(e), '.claude'), 'skills'),
  ],
  mcpConfig: (e) => ({
    path: join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'opencode', 'opencode.jsonc'),
    format: 'jsonc',
  }),
  mcpWritable: true,
});

export const geminiCliAdapter = makeAdapter({
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  category: 'cli',
  entryFiles: ['GEMINI.md'],
  configHome: (e) => join(home(e), '.gemini'),
  presenceProof: async (e) => (await whichBin('gemini', e)) !== null,
  skillDirs: (e) => [join(home(e), '.gemini', 'skills')],
  mcpConfig: (e) => ({ path: join(home(e), '.gemini', 'settings.json'), format: 'json' }),
  mcpWritable: true,
});

export const cursorAdapter = makeAdapter({
  id: 'cursor',
  displayName: 'Cursor',
  category: 'desktop',
  entryFiles: ['.cursorrules', '.cursor/rules'],
  configHome: (e) => join(home(e), '.cursor'),
  presenceProof: async (e) =>
    (await exists('/Applications/Cursor.app')) || (await whichBin('cursor-agent', e)) !== null,
  mcpConfig: (e) => ({ path: join(home(e), '.cursor', 'mcp.json'), format: 'json' }),
  mcpWritable: true,
});

export const hermesAdapter = makeAdapter({
  id: 'hermes',
  displayName: 'Hermes',
  category: 'daemon',
  entryFiles: ['SOUL.md'],
  configHome: (e) => environ(e)['HERMES_HOME'] ?? join(home(e), '.hermes'),
  presenceProof: async (e) =>
    (await exists(join(environ(e)['HERMES_HOME'] ?? join(home(e), '.hermes'), 'gateway.sock'))) ||
    (await whichBin('hermes', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'config.yaml'))) ? 'config.yaml found' : undefined),
  skillDirs: (e) => [join(environ(e)['HERMES_HOME'] ?? join(home(e), '.hermes'), 'skills')],
  memoryDirs: (e) => [join(environ(e)['HERMES_HOME'] ?? join(home(e), '.hermes'), 'memories')],
  mcpConfig: (e) => ({ path: join(environ(e)['HERMES_HOME'] ?? join(home(e), '.hermes'), 'config.yaml'), format: 'yaml' }),
  mcpWritable: true,
});

/**
 * Pi (pi-coding-agent). Its skill roots include the agentDir skills dir AND
 * the ECC shared pool ~/.agents/skills (user level — the [u] entries in
 * /skill completion). The pool is listed first so it stays the toggle target:
 * it is where pi actually resolves user skills today.
 */
export const piAdapter = makeAdapter({
  id: 'pi',
  displayName: 'Pi',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  // Pi's agent dir: PI_CODING_AGENT_DIR (default ~/.pi/agent).
  configHome: (e) => environ(e)['PI_CODING_AGENT_DIR'] ?? join(home(e), '.pi', 'agent'),
  presenceProof: async (e) => (await whichBin('pi', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
  skillDirs: (e) => [
    join(home(e), '.agents', 'skills'),
    join(environ(e)['PI_CODING_AGENT_DIR'] ?? join(home(e), '.pi', 'agent'), 'skills'),
  ],
  // Pi has no built-in MCP; users opt in via an MCP extension, which reads
  // ~/.pi/agent/mcp.json — we manage that file.
  mcpConfig: (e) => ({
    path: join(environ(e)['PI_CODING_AGENT_DIR'] ?? join(home(e), '.pi', 'agent'), 'mcp.json'),
    format: 'json',
  }),
  mcpWritable: true,
});

/** Grok CLI (xAI). Config ~/.grok (config.toml, TOML); MCP uses the same
 *  `[mcp_servers.*]` TOML layout as Codex, so the TOML writer can manage it.
 *  Entry files: it scans Agents.md / Claude.md / AGENT.md / AGENTS.md. */
export const grokAdapter = makeAdapter({
  id: 'grok',
  displayName: 'Grok',
  category: 'cli',
  entryFiles: ['AGENTS.md', 'Claude.md', 'AGENT.md', 'Agents.md'],
  configHome: (e) => join(home(e), '.grok'),
  presenceProof: async (e) =>
    (await exists(join(home(e), '.grok', 'bin', 'grok'))) || (await whichBin('grok', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'config.toml'))) ? 'config.toml found' : undefined),
  skillDirs: (e) => [join(home(e), '.grok', 'skills')],
  // memory-v2 keeps maintained Markdown topics per scope; the sync walker
  // skips the sqlite indexes and observation dumps next to them.
  memoryDirs: (e) => [
    join(home(e), '.grok', 'memory-v2', 'global', 'topics'),
    join(home(e), '.grok', 'memory-v2', 'workspaces'),
  ],
  mcpConfig: (e) => ({ path: join(home(e), '.grok', 'config.toml'), format: 'toml' }),
  mcpWritable: true,
});

/** Qwen Code (Gemini CLI fork). Config ~/.qwen/settings.json; entry QWEN.md. */
export const qwenCodeAdapter = makeAdapter({
  id: 'qwen-code',
  displayName: 'Qwen Code',
  category: 'cli',
  entryFiles: ['QWEN.md'],
  configHome: (e) => join(home(e), '.qwen'),
  presenceProof: async (e) => (await whichBin('qwen', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
  skillDirs: (e) => [join(home(e), '.qwen', 'skills')],
  mcpConfig: (e) => ({ path: join(home(e), '.qwen', 'settings.json'), format: 'json' }),
  mcpWritable: true,
});

/** Kimi Code (Moonshot; successor of Kimi CLI). Home ~/.kimi-code with its own
 *  bundled bin/kimi, config.toml (TOML) and mcp.json (standard mcpServers). */
export const kimiCodeAdapter = makeAdapter({
  id: 'kimi-code',
  displayName: 'Kimi Code',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(home(e), '.kimi-code'),
  presenceProof: async (e) =>
    (await exists(join(home(e), '.kimi-code', 'bin', 'kimi'))) || (await whichBin('kimi', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'config.toml'))) ? 'config.toml found' : undefined),
  skillDirs: (e) => [join(home(e), '.kimi-code', 'skills')],
  mcpConfig: (e) => ({ path: join(home(e), '.kimi-code', 'mcp.json'), format: 'json' }),
  mcpWritable: true,
});

/** Legacy Kimi CLI (MoonshotAI/kimi-cli, being sunset in favor of Kimi Code). */
export const kimiCliAdapter = makeAdapter({
  id: 'kimi-cli',
  displayName: 'Kimi CLI',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(home(e), '.kimi'),
  presenceProof: async (e) => (await whichBin('kimi', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'config.toml'))) ? 'config.toml found' : undefined),
  skillDirs: (e) => [join(home(e), '.kimi', 'skills')],
  mcpConfig: (e) => ({ path: join(home(e), '.kimi', 'mcp.json'), format: 'json' }),
  mcpWritable: true,
});

/** Amp (Sourcegraph). Config ~/.config/amp/settings.json; MCP lives under the
 *  nested `amp.mcpServers` key — exposed for reading, not written by Agora. */
export const ampAdapter = makeAdapter({
  id: 'amp',
  displayName: 'Amp',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'amp'),
  presenceProof: async (e) => (await whichBin('amp', e)) !== null,
  detectDetail: async (dir) =>
    (await exists(join(dir, 'settings.json'))) || (await exists(join(dir, 'settings.jsonc')))
      ? 'settings.json found'
      : undefined,
  skillDirs: (e) => [join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'amp', 'skills')],
});

/** Crush (Charm). XDG config ~/.config/crush; main config is a bash `crushrc`
 *  (legacy crush.json deprecated), so Agora does not write its MCP config. */
export const crushAdapter = makeAdapter({
  id: 'crush',
  displayName: 'Crush',
  category: 'cli',
  entryFiles: ['AGENTS.md', 'CRUSH.md'],
  configHome: (e) => join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'crush'),
  presenceProof: async (e) => (await whichBin('crush', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'crushrc'))) ? 'crushrc found' : undefined),
  skillDirs: (e) => [join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'crush', 'skills')],
});

/** Aider. No config home — its config is a single YAML file ~/.aider.conf.yml
 *  (stat works on files too). No MCP, no skills; CONVENTIONS.md is manual. */
export const aiderAdapter = makeAdapter({
  id: 'aider',
  displayName: 'Aider',
  category: 'cli',
  entryFiles: ['CONVENTIONS.md'],
  configHome: (e) => join(home(e), '.aider.conf.yml'),
  presenceProof: async (e) => (await whichBin('aider', e)) !== null,
});

/** Amazon Q Developer CLI (unmaintained upstream; successor is Kiro CLI).
 *  MCP: legacy ~/.aws/amazonq/mcp.json with standard mcpServers. */
export const amazonQAdapter = makeAdapter({
  id: 'amazon-q',
  displayName: 'Amazon Q',
  category: 'cli',
  entryFiles: ['AmazonQ.md'],
  configHome: (e) => join(home(e), '.aws', 'amazonq'),
  presenceProof: async (e) =>
    (await exists('/Applications/Amazon Q.app')) || (await whichBin('q', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'mcp.json'))) ? 'mcp.json found' : undefined),
  mcpConfig: (e) => ({ path: join(home(e), '.aws', 'amazonq', 'mcp.json'), format: 'json' }),
  mcpWritable: true,
});

/** Factory Droid. Config ~/.factory/settings.json; MCP ~/.factory/mcp.json. */
export const droidAdapter = makeAdapter({
  id: 'droid',
  displayName: 'Droid',
  category: 'cli',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(home(e), '.factory'),
  presenceProof: async (e) => (await whichBin('droid', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
  skillDirs: (e) => [join(home(e), '.factory', 'skills')],
  mcpConfig: (e) => ({ path: join(home(e), '.factory', 'mcp.json'), format: 'json' }),
  mcpWritable: true,
});

/** iFlow CLI (Gemini CLI fork; announced EOL 2026-04). Config ~/.iflow. */
export const iflowAdapter = makeAdapter({
  id: 'iflow-cli',
  displayName: 'iFlow CLI',
  category: 'cli',
  entryFiles: ['IFLOW.md'],
  configHome: (e) => join(home(e), '.iflow'),
  presenceProof: async (e) => (await whichBin('iflow', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
  mcpConfig: (e) => ({ path: join(home(e), '.iflow', 'settings.json'), format: 'json' }),
});

/** Windsurf (desktop IDE). Config ~/.codeium/windsurf (mcp_config.json). */
export const windsurfAdapter = makeAdapter({
  id: 'windsurf',
  displayName: 'Windsurf',
  category: 'desktop',
  entryFiles: ['AGENTS.md', '.windsurf/rules'],
  configHome: (e) => join(home(e), '.codeium', 'windsurf'),
  presenceProof: async (e) =>
    (await exists('/Applications/Windsurf.app')) || (await whichBin('windsurf', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'mcp_config.json'))) ? 'mcp_config.json found' : undefined),
  mcpConfig: (e) => ({ path: join(home(e), '.codeium', 'windsurf', 'mcp_config.json'), format: 'json' }),
  mcpWritable: true,
});

/** Zed (editor with agent panel). Config ~/.config/zed; MCP uses the
 *  `context_servers` key in settings.json — read-only ref, not written. */
export const zedAdapter = makeAdapter({
  id: 'zed',
  displayName: 'Zed',
  category: 'desktop',
  entryFiles: ['AGENTS.md'],
  configHome: (e) => join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'zed'),
  presenceProof: async (e) =>
    (await exists('/Applications/Zed.app')) || (await whichBin('zed', e)) !== null,
  detectDetail: async (dir) => ((await exists(join(dir, 'settings.json'))) ? 'settings.json found' : undefined),
});

/** The cross-agent shared skill pool (ECC convention: ~/.agents/skills). */
export const sharedPoolAdapter = makeAdapter({
  id: 'shared-pool',
  displayName: '共享池 (~/.agents)',
  category: 'cli',
  entryFiles: [],
  configHome: (e) => join(home(e), '.agents'),
  detectDetail: async (dir) => ((await exists(join(dir, 'skills'))) ? 'skills/ found' : undefined),
  skillDirs: (e) => [join(home(e), '.agents', 'skills')],
  kind: 'virtual',
});

/** Agora's own central store (skills installed via the hub land here). */
export const agoraStoreAdapter = makeAdapter({
  id: 'agora-store',
  displayName: 'Agora 仓库',
  category: 'cli',
  entryFiles: [],
  configHome: (e) => join(environ(e)['AGORA_HOME'] ?? join(home(e), '.agora'), 'store'),
  detectDetail: async (dir) => ((await exists(join(dir, 'skills'))) ? 'skills/ found' : undefined),
  skillDirs: (e) => [join(environ(e)['AGORA_HOME'] ?? join(home(e), '.agora'), 'store', 'skills')],
  kind: 'virtual',
});

/** Built-in adapters. Custom adapters can be registered alongside these. */
export const builtinAdapters: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
  geminiCliAdapter,
  grokAdapter,
  qwenCodeAdapter,
  kimiCodeAdapter,
  kimiCliAdapter,
  ampAdapter,
  crushAdapter,
  aiderAdapter,
  amazonQAdapter,
  droidAdapter,
  iflowAdapter,
  cursorAdapter,
  windsurfAdapter,
  zedAdapter,
  hermesAdapter,
  // pi precedes the shared pool: they scan the same dir, and location dedup
  // keeps the first report so pool skills are attributed to the real agent.
  piAdapter,
  sharedPoolAdapter,
  agoraStoreAdapter,
];

export async function detectAgents(env?: AdapterEnv, adapters: AgentAdapter[] = builtinAdapters): Promise<AgentDetection[]> {
  return Promise.all(adapters.map((a) => a.detect(env)));
}
