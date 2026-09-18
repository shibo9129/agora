import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters } from '@agora/adapters';
import { enrollAgent, hubStatus, unenrollAgent, HUB_MCP_SERVER_NAME } from '../index.js';

let root: string;
let env: { home: string; env: NodeJS.ProcessEnv };
let memoryRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-hub-enroll-'));
  // Fake CLI binaries so presenceProof sees the agents as installed.
  const fakeBinDir = join(root, 'fake-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  for (const bin of ['codex', 'opencode', 'gemini', 'claude', 'hermes', 'cursor-agent']) {
    writeFileSync(join(fakeBinDir, bin), '#!/bin/sh\n');
    chmodSync(join(fakeBinDir, bin), 0o755);
  }
  env = { home: root, env: { PATH: `${fakeBinDir}:${process.env['PATH']}` } };
  memoryRoot = join(root, 'memory');
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex/config.toml'), 'model = "gpt-5.1"\n');
  mkdirSync(join(root, '.config/opencode'), { recursive: true });
  writeFileSync(join(root, '.config/opencode/opencode.jsonc'), '{}\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('enroll/unenroll', () => {
  it('enrolls codex: registers hub MCP and injects the guide block', async () => {
    const result = await enrollAgent('codex', memoryRoot, env, builtinAdapters);
    expect(result.mcp.action).toBe('upserted');

    const toml = readFileSync(join(root, '.codex/config.toml'), 'utf-8');
    expect(toml).toContain(`[mcp_servers.${HUB_MCP_SERVER_NAME}]`);
    expect(toml).toContain('mcp-stdio.ts');
    expect(toml).toContain('model = "gpt-5.1"'); // existing content kept

    const agents = readFileSync(join(root, '.codex/AGENTS.md'), 'utf-8');
    expect(agents).toContain('BEGIN AGORA-MANAGED:agora-hub');
    expect(agents).toContain('memory_search');
    expect(agents).toContain('MEMORY.md');
  });

  it('records ownership under the enrolled home, never the real ~/.agora', async () => {
    // Regression: the manifest path used to come from the process environment,
    // so a run against a sandboxed home (this test, a second profile) wrote its
    // entries into the developer's real ~/.agora — where unenroll could never
    // match them again, and where they accumulated as paths to deleted dirs.
    const manifest = join(root, '.agora/hub-manifest.json');
    expect(existsSync(manifest)).toBe(true);
    const { files } = JSON.parse(readFileSync(manifest, 'utf-8')) as { files: Record<string, string[]> };
    expect(Object.keys(files).length).toBeGreaterThan(0);
    for (const filePath of Object.keys(files)) expect(filePath.startsWith(root)).toBe(true);
  });

  it('reports status correctly', async () => {
    const status = await hubStatus(env, builtinAdapters);
    const codex = status.find((s) => s.agent === 'codex')!;
    expect(codex.mcpRegistered).toBe(true);
    expect(codex.entryBlockPresent).toBe(true);
    const opencode = status.find((s) => s.agent === 'opencode')!;
    expect(opencode.mcpRegistered).toBe(false);
    expect(opencode.entryBlockPresent).toBe(false);
  });

  it('unenrolls cleanly: MCP registration and block both removed', async () => {
    await unenrollAgent('codex', env, builtinAdapters);
    const toml = readFileSync(join(root, '.codex/config.toml'), 'utf-8');
    expect(toml).not.toContain(`[mcp_servers.${HUB_MCP_SERVER_NAME}]`);
    expect(toml).toContain('model = "gpt-5.1"');
    const agents = readFileSync(join(root, '.codex/AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('AGORA-MANAGED');
    const status = await hubStatus(env, builtinAdapters);
    const codex = status.find((s) => s.agent === 'codex')!;
    expect(codex.mcpRegistered).toBe(false);
    expect(codex.entryBlockPresent).toBe(false);
  });

  it('enrolls opencode via jsonc path', async () => {
    const result = await enrollAgent('opencode', memoryRoot, env, builtinAdapters);
    expect(result.mcp.action).toBe('upserted');
    const jsonc = readFileSync(join(root, '.config/opencode/opencode.jsonc'), 'utf-8');
    expect(jsonc).toContain('"agora"');
    expect(jsonc).toContain('mcp-stdio.ts');
    expect(existsSync(join(root, '.config/opencode/AGENTS.md'))).toBe(true);
  });
});
