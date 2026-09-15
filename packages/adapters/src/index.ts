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
      };
      if (detail !== undefined) detection.detail = detail;
      if (def.kind !== undefined) detection.kind = def.kind;
      return detection;
    },
  };
  return adapter;
}

/** Find a CLI binary on PATH (posix `which` semantics, no shell). */
export async function whichBin(name: string, env?: AdapterEnv): Promise<string | null> {
  const pathEnv = (env?.env ?? process.env)['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

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
  skillDirs: (e) => [join(environ(e)['XDG_CONFIG_HOME'] ?? join(home(e), '.config'), 'opencode', 'skills')],
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
  cursorAdapter,
  hermesAdapter,
  sharedPoolAdapter,
  agoraStoreAdapter,
];

export async function detectAgents(env?: AdapterEnv, adapters: AgentAdapter[] = builtinAdapters): Promise<AgentDetection[]> {
  return Promise.all(adapters.map((a) => a.detect(env)));
}
