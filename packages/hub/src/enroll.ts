/**
 * Agent enrollment: register the Agora hub MCP server into an agent's config
 * and inject the usage guide into its entry file — both reversible.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';
import { scanMcpRegistrations, setMcpServerForAgent } from '@agora/tools';

import { hasManagedBlock, removeManagedBlock, upsertManagedBlock } from './blocks.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const HUB_MCP_SERVER_NAME = 'agora';
export const HUB_BLOCK_ID = 'agora-hub';
export const HUB_SYNC_RULE_BLOCK_ID = 'agora-memory-sync';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the stdio MCP server entry script (dev checkout). */
export function hubMcpEntryPath(): string {
  return join(here, 'mcp-stdio.ts');
}

function whichBin(name: string): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The MCP registration written into agent configs.
 * Preference: the installed `agora` bin (production) → tsx dev entry.
 * Override entirely with AGORA_MCP_COMMAND (space-separated).
 */
export function hubMcpSpec(): { type: 'local'; command: string[]; raw: Record<string, unknown> } {
  const override = process.env['AGORA_MCP_COMMAND'];
  let command: string[];
  if (override) {
    command = override.split(' ').filter(Boolean);
  } else if (existsSync(join(here, 'mcp-stdio.mjs'))) {
    command = [process.execPath, join(here, 'mcp-stdio.mjs')];
  } else {
    const bin = whichBin('agora');
    command = bin ? [bin, 'mcp'] : ['npx', '-y', 'tsx', hubMcpEntryPath()];
  }
  const env = Object.fromEntries(['AGORA_HOME', 'AGORA_DB'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  return { type: 'local', command, raw: { type: 'local', command, env } };
}

function guideBlock(memoryRoot: string): string {
  return `## Agora 本地 AI 中枢

本 Agent 已接入 Agora 中枢（记忆库 + 知识库）。

- **记忆**：跨 Agent 共享。检索用 \`memory_search\`（返回一行摘要+路径），按需 \`memory_read\` 展开全文；重要结论（决策/偏好/事实）用 \`memory_write\` 回写，abstract 写一行好摘要。根索引：\`${join(memoryRoot, 'MEMORY.md')}\`
- **知识库**：\`kb_list\` 看已注册知识库，\`kb_search\` 按文件名检索。
- 规则：先搜后写；不写密钥/密码/私人凭据；项目级记忆用 scope=project-<项目标识>。`;
}

export interface EnrollResult {
  agent: string;
  mcp: { action: string; configPath?: string; skipped?: boolean; reason?: string };
  entryFile: { path: string; action: string } | { skipped: true; reason: string };
}

export async function enrollAgent(
  agentId: string,
  memoryRoot: string,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<EnrollResult> {
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);

  // 1. MCP registration (writable agents only; others get manual guidance).
  let mcp: EnrollResult['mcp'];
  if (adapter.mcpWritable === true) {
    const r = await setMcpServerForAgent(agentId, HUB_MCP_SERVER_NAME, hubMcpSpec(), env, adapters);
    mcp = { action: r.action, configPath: r.configPath };
  } else {
    mcp = { action: 'skipped', skipped: true, reason: `${agentId} 配置不支持写入，请手动添加 MCP 注册` };
  }

  // 2. Entry-file guide block.
  const detection = await adapter.detect(env);
  const entryName = adapter.entryFiles[0];
  let entryFile: EnrollResult['entryFile'];
  if (!entryName) {
    entryFile = { skipped: true, reason: '该 agent 无入口文件约定' };
  } else {
    const entryPath = join(detection.configHome, entryName);
    const r = await upsertManagedBlock(entryPath, HUB_BLOCK_ID, guideBlock(memoryRoot), env);
    entryFile = { path: entryPath, action: r.action };
  }

  return { agent: agentId, mcp, entryFile };
}

export async function unenrollAgent(
  agentId: string,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<EnrollResult> {
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);

  let mcp: EnrollResult['mcp'];
  if (adapter.mcpWritable === true) {
    const r = await setMcpServerForAgent(agentId, HUB_MCP_SERVER_NAME, null, env, adapters);
    mcp = { action: r.action, configPath: r.configPath };
  } else {
    mcp = { action: 'skipped', skipped: true, reason: `${agentId} 配置不支持写入` };
  }

  const detection = await adapter.detect(env);
  const entryName = adapter.entryFiles[0];
  let entryFile: EnrollResult['entryFile'];
  if (!entryName) {
    entryFile = { skipped: true, reason: '该 agent 无入口文件约定' };
  } else {
    const entryPath = join(detection.configHome, entryName);
    const r = await removeManagedBlock(entryPath, HUB_BLOCK_ID, env);
    entryFile = { path: entryPath, action: r.action };
  }

  return { agent: agentId, mcp, entryFile };
}

function syncRuleBlock(memoryRoot: string): string {
  return `## 记忆同步规则（Agora 自动同步已启用）

- 本 Agent 产生的需要长期记忆的信息（项目关键决策、落地结果、用户偏好事实），请用 agora MCP 的 \`memory_write\` 写入中枢，abstract 写一行好摘要
- 记忆会被定期同步并精炼到中央仓库：\`${memoryRoot}\`
- 先搜（\`memory_search\`）后写，避免重复记忆；不写密钥/密码/私人凭据`;
}

/** Write (or remove) the auto-sync rule block into an agent's entry file. */
export async function setMemorySyncRule(
  agentId: string,
  memoryRoot: string,
  enable: boolean,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<{ agent: string; action: string; path?: string }> {
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);
  const entryName = adapter.entryFiles[0];
  if (!entryName) return { agent: agentId, action: 'skipped-no-entry' };
  const detection = await adapter.detect(env);
  const entryPath = join(detection.configHome, entryName);
  if (enable) {
    const r = await upsertManagedBlock(entryPath, HUB_SYNC_RULE_BLOCK_ID, syncRuleBlock(memoryRoot), env);
    return { agent: agentId, action: r.action, path: entryPath };
  }
  const r = await removeManagedBlock(entryPath, HUB_SYNC_RULE_BLOCK_ID, env);
  return { agent: agentId, action: r.action, path: entryPath };
}

export interface HubAgentStatus {
  agent: string;
  displayName: string;
  mcpRegistered: boolean;
  /**
   * Registered under the right name but pointing somewhere else than the hub
   * this process would write — a dev checkout left behind by an older install,
   * a moved app bundle. The agent looks enrolled and fails at handshake time,
   * so it has to be reported separately from "not registered".
   */
  mcpStale: boolean;
  /** What the agent's config currently launches, for the UI to show. */
  mcpCommand?: string;
  entryBlockPresent: boolean;
  entryFilePath?: string;
  enrollable: boolean;
}

/** The command this process would register, as a comparable string. */
export function hubMcpCommandLine(): string {
  return hubMcpSpec().command.join(' ');
}

/**
 * True when the only registration this process can offer is the dev fallback
 * (`npx tsx <checkout>`), which dies with the checkout. Running the hub from
 * source must not repoint a machine's agents away from their installed app,
 * so automatic repair stands down in that case — an explicit click still
 * writes whatever this process is.
 */
export function hubMcpIsDevFallback(): boolean {
  const [bin, ...rest] = hubMcpSpec().command;
  return bin === 'npx' && rest.includes('tsx');
}

export async function hubStatus(env?: AdapterEnv, adapters: AgentAdapter[] = builtinAdapters): Promise<HubAgentStatus[]> {
  const out: HubAgentStatus[] = [];
  for (const adapter of adapters) {
    if (adapter.id === 'shared-pool') continue;
    const detection = await adapter.detect(env);
    if (!detection.installed) continue;
    let mcpRegistered = false;
    let mcpStale = false;
    let mcpCommand: string | undefined;
    try {
      const regs = await scanMcpRegistrations(adapter, env);
      const hub = regs.find((r) => r.serverName === HUB_MCP_SERVER_NAME);
      mcpRegistered = hub !== undefined;
      if (hub) {
        mcpCommand = hub.spec.command?.join(' ') ?? hub.spec.url ?? '';
        // From a dev checkout there is no authoritative "correct" command to
        // compare against, so nothing is reported stale — flagging a healthy
        // packaged install as broken would be worse than staying quiet.
        mcpStale = mcpCommand !== hubMcpCommandLine() && !hubMcpIsDevFallback();
      }
    } catch {
      // unreadable config counts as not registered
    }
    const entryName = adapter.entryFiles[0];
    let entryBlockPresent = false;
    let entryFilePath: string | undefined;
    if (entryName) {
      entryFilePath = join(detection.configHome, entryName);
      if (existsSync(entryFilePath)) {
        try {
          entryBlockPresent = hasManagedBlock(await readFile(entryFilePath, 'utf-8'), HUB_BLOCK_ID);
        } catch {
          // unreadable
        }
      }
    }
    const status: HubAgentStatus = {
      agent: adapter.id,
      displayName: adapter.displayName,
      mcpRegistered,
      mcpStale,
      entryBlockPresent,
      enrollable: adapter.mcpWritable === true,
    };
    if (mcpCommand !== undefined) status.mcpCommand = mcpCommand;
    if (entryFilePath !== undefined) status.entryFilePath = entryFilePath;
    out.push(status);
  }
  return out;
}
