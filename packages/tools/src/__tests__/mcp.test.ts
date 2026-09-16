import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters } from '@agora/adapters';
import {
  runHealthChecks,
  scanUnifiedMcpServers,
  setJsoncMcpServer,
  setMcpServerForAgent,
  setTomlMcpServer,
  serializeTomlSection,
} from '../index.js';

let root: string;
let env: { home: string; env: NodeJS.ProcessEnv };

const OPENCODE_JSONC = `{
  // 用户的 opencode 配置（注释必须保留）
  "model": "example-ai-coding/k3",
  "mcp": {
    "api": {
      "type": "local",
      "command": ["node", "api-mcp.js"] // 行尾注释也要保留
    },
    "remote-hub": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp?token=SECRET123"
    }
  }
}
`;

const CODEX_TOML = `# Codex 配置（注释必须保留）
model = "gpt-5.1"

[mcp_servers.api]
url = "https://mcp.example.com/mcp-servers/api-mcp-doc?token=SECRET456"
startup_timeout_sec = 20

[mcp_servers.docs]
command = "npx"
args = ["-y", "@openai/developer-docs"]

[plugins]
foo = true
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-tools-mcp-'));
  env = { home: root, env: {} };
  mkdirSync(join(root, '.config/opencode'), { recursive: true });
  writeFileSync(join(root, '.config/opencode/opencode.jsonc'), OPENCODE_JSONC);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex/config.toml'), CODEX_TOML);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mcp scan', () => {
  it('parses jsonc and toml registrations into a unified view', async () => {
    const servers = await scanUnifiedMcpServers(env, builtinAdapters);
    const names = servers.map((s) => s.name);
    expect(names).toContain('api');
    expect(names).toContain('remote-hub');
    expect(names).toContain('docs');
    const api = servers.find((s) => s.name === 'api')!;
    expect(api.registrations.length).toBe(2); // opencode + codex
    expect(api.drift).toBe(true); // cmd vs url
    const docs = servers.find((s) => s.name === 'docs')!;
    expect(docs.drift).toBe(false);
  });

  it('redacts tokens in signatures', async () => {
    const servers = await scanUnifiedMcpServers(env, builtinAdapters);
    const api = servers.find((s) => s.name === 'api')!;
    const codexReg = api.registrations.find((r) => r.agent === 'codex')!;
    expect(JSON.stringify(codexReg.spec)).not.toContain('SECRET456');
    expect(api.signature).not.toContain('SECRET456');
    expect(api.signature).toContain('***');
  });
});

describe('jsonc writer', () => {
  it('upserts a server while preserving comments', () => {
    const next = setJsoncMcpServer(OPENCODE_JSONC, 'new-server', {
      type: 'remote',
      url: 'http://example.com/mcp',
      raw: { type: 'remote', url: 'http://example.com/mcp' },
    });
    expect(next).toContain('// 用户的 opencode 配置（注释必须保留）');
    expect(next).toContain('// 行尾注释也要保留');
    expect(next).toContain('"new-server"');
    expect(next).toContain('http://example.com/mcp');
    // existing entries untouched
    expect(next).toContain('"remote-hub"');
  });

  it('removes a server entry', () => {
    const next = setJsoncMcpServer(OPENCODE_JSONC, 'remote-hub', null);
    expect(next).not.toContain('"remote-hub"');
    expect(next).toContain('"api"');
    expect(next).toContain('// 用户的 opencode 配置（注释必须保留）');
  });
});

describe('toml writer', () => {
  it('replaces a section without touching others', () => {
    const next = setTomlMcpServer(CODEX_TOML, 'api', {
      type: 'remote',
      url: 'http://new-host:9999/mcp',
      raw: { url: 'http://new-host:9999/mcp', startup_timeout_sec: 30 },
    });
    expect(next).toContain('# Codex 配置（注释必须保留）');
    expect(next).toContain('url = "http://new-host:9999/mcp"');
    expect(next).toContain('startup_timeout_sec = 30');
    expect(next).toContain('[mcp_servers.docs]'); // sibling untouched
    expect(next).toContain('[plugins]');
    expect(next).not.toContain('SECRET456');
  });

  it('removes a section cleanly', () => {
    const next = setTomlMcpServer(CODEX_TOML, 'docs', null);
    expect(next).not.toContain('[mcp_servers.docs]');
    expect(next).not.toContain('developer-docs');
    expect(next).toContain('[mcp_servers.api]');
    expect(next).toContain('[plugins]');
  });

  it('appends a new section into the mcp_servers cluster', () => {
    const next = setTomlMcpServer(CODEX_TOML, 'fresh', {
      type: 'local',
      command: ['uvx', 'fresh-mcp'],
      raw: {},
    });
    expect(next).toContain('[mcp_servers.fresh]');
    expect(next).toContain('command = "uvx"');
    expect(next.indexOf('[mcp_servers.fresh]')).toBeLessThan(next.indexOf('[plugins]'));
  });

  it('serializes quoted names safely', () => {
    const block = serializeTomlSection('my server!', { command: ['npx', 'x'], raw: {} });
    expect(block).toContain('[mcp_servers."my server!"]');
  });
});

describe('mcp write (with backup)', () => {
  it('upserts into opencode.jsonc and leaves a .bak backup', async () => {
    const target = join(root, '.config/opencode/opencode.jsonc');
    const result = await setMcpServerForAgent(
      'opencode',
      'installed-by-agora',
      { type: 'remote', url: 'http://localhost:1234/mcp', raw: { type: 'remote', url: 'http://localhost:1234/mcp' } },
      env,
      builtinAdapters,
    );
    expect(result.action).toBe('upserted');
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('"installed-by-agora"');
    expect(content).toContain('// 用户的 opencode 配置（注释必须保留）');
  });

  it('removes from config.toml with backup', async () => {
    const result = await setMcpServerForAgent('codex', 'docs', null, env, builtinAdapters);
    expect(result.action).toBe('removed');
    expect(existsSync(result.backupPath!)).toBe(true);
    const content = readFileSync(join(root, '.codex/config.toml'), 'utf-8');
    expect(content).not.toContain('[mcp_servers.docs]');
    expect(content).toContain('[mcp_servers.api]');
  });

  it('refuses agents without an mcp config location', async () => {
    await expect(setMcpServerForAgent('shared-pool', 'x', null, env, builtinAdapters)).rejects.toThrow('不支持写入');
  });
});

describe('health checks', () => {
  it('reports mcp drift and missing config homes', async () => {
    const issues = await runHealthChecks(env, builtinAdapters);
    const drift = issues.find((i) => i.kind === 'mcp-drift' && i.message.includes('api'));
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe('error');
    const missing = issues.filter((i) => i.kind === 'declared-missing');
    expect(missing.length).toBeGreaterThan(0); // gemini/cursor/hermes not in fixture
  });
});

it('writes standard JSON MCP commands as command and args', () => {
  const doc = JSON.parse(setJsoncMcpServer('{}', 'agora', { type: 'local', command: ['node','server.mjs'], raw: { environment: { AGORA_HOME: '/tmp/test' } } }, 'mcpServers'));
  expect(doc.mcpServers.agora).toEqual({command:'node', args:['server.mjs'], env:{AGORA_HOME:'/tmp/test'}});
});
it('preserves hub environment in TOML', () => {
  expect(serializeTomlSection('agora', {type:'local',command:['node','mcp.mjs'],raw:{env:{AGORA_HOME:'/tmp/test'}}})).toContain('env = { "AGORA_HOME" = "/tmp/test" }');
});
