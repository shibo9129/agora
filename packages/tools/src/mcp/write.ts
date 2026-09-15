/**
 * Unified MCP write path: backup → format-specific edit → atomic replace.
 * Only adapters marked `mcpWritable` are eligible (codex/opencode by default).
 */

import { copyFile, readFile, rename, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import { setJsoncMcpServer } from './jsonc-writer.js';
import { setTomlMcpServer } from './toml-writer.js';
import { setYamlMcpServer } from './yaml-writer.js';
import type { McpServerSpec } from '../types.js';

export class McpWriteError extends Error {}

async function backup(path: string): Promise<string> {
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(path, backupPath);
  return backupPath;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = join(join(path, '..'), `.agora-tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export interface McpWriteResult {
  agent: string;
  serverName: string;
  action: 'upserted' | 'removed' | 'noop';
  configPath: string;
  backupPath?: string;
}

export async function setMcpServerForAgent(
  agentId: string,
  serverName: string,
  spec: McpServerSpec | null,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<McpWriteResult> {
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new McpWriteError(`未知 agent: ${agentId}`);
  if (adapter.mcpWritable !== true) {
    throw new McpWriteError(`Agent ${agentId} 的配置不支持写入（仅只读扫描）`);
  }
  const ref = adapter.mcpConfig?.(env);
  if (!ref) throw new McpWriteError(`Agent ${agentId} 无 MCP 配置位置`);

  let text = '';
  let exists = true;
  try {
    text = await readFile(ref.path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
    if (spec === null) {
      return { agent: agentId, serverName, action: 'noop', configPath: ref.path };
    }
    // Creating a brand-new config file with just the MCP table.
    text = ref.format === 'toml' ? '' : '{}\n';
  }

  let next: string;
  if (ref.format === 'toml') {
    next = setTomlMcpServer(text, serverName, spec);
  } else if (ref.format === 'jsonc' || ref.format === 'json') {
    const preferred = agentId === 'opencode' ? 'mcp' : 'mcpServers';
    next = setJsoncMcpServer(text, serverName, spec, preferred);
  } else if (ref.format === 'yaml') {
    next = setYamlMcpServer(text, serverName, spec);
  } else {
    throw new McpWriteError(`格式 ${ref.format} 不支持写入`);
  }
  if (next === text) {
    return { agent: agentId, serverName, action: 'noop', configPath: ref.path };
  }
  const result: McpWriteResult = {
    agent: agentId,
    serverName,
    action: spec === null ? 'removed' : 'upserted',
    configPath: ref.path,
  };
  if (exists) result.backupPath = await backup(ref.path);
  await atomicWrite(ref.path, next);
  return result;
}
