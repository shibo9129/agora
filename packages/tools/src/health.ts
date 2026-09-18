/**
 * Health checks: MCP drift, broken skill links, declared-but-missing config
 * homes, duplicate real skill installs.
 *
 * Every issue carries `why` (what was observed) and `fix` (what to do, which
 * is sometimes "nothing"). A checklist the user cannot act on is worse than no
 * checklist: it just makes a working machine look broken.
 */

import { stat } from 'node:fs/promises';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import { scanUnifiedMcpServers } from './mcp/scan.js';
import { scanUnifiedSkills } from './skills/scan.js';
import type { HealthIssue } from './types.js';

export async function runHealthChecks(
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];

  // 1. Agents that used to be set up but no longer are (config dir remains,
  // app binary gone) — a real regression. An adapter that was simply never
  // installed ('absent') is normal, expected state, not a health issue.
  for (const adapter of adapters) {
    try {
      const detection = await adapter.detect(env);
      if (detection.presence === 'residual') {
        issues.push({
          kind: 'declared-missing',
          severity: 'warn',
          message: `${adapter.displayName} 配置残留，但应用本体未找到（已卸载或未安装）`,
          detail: detection.configHome,
          subject: adapter.id,
          paths: [detection.configHome],
          why: `这个目录里还留着 ${adapter.displayName} 的配置，但机器上找不到它的可执行文件。`,
          fix: '不影响任何功能，Agora 不会动它。你确实不再用这个 Agent 的话，可以自己删掉该目录；打算继续用就重新安装它。',
        });
      }
    } catch {
      // detection failure is not an issue by itself
    }
  }

  // 2. MCP drift: same server name registered with different signatures.
  const servers = await scanUnifiedMcpServers(env, adapters);
  for (const server of servers) {
    if (!server.drift) continue;
    const bySignature = new Map<string, string[]>();
    for (const reg of server.registrations) {
      bySignature.set(reg.signature, [...(bySignature.get(reg.signature) ?? []), reg.agent]);
    }
    const variants = [...bySignature.entries()]
      .map(([sig, agents]) => `${agents.join('、')} → ${sig.replace(/^(cmd|url):/, '')}`)
      .join('\n');
    issues.push({
      kind: 'mcp-drift',
      severity: 'error',
      message: `MCP「${server.name}」在多个 Agent 中配置不一致`,
      detail: variants,
      subject: server.name,
      why: `同一个 server 名字在 ${server.registrations.length} 个 Agent 里指向了 ${bySignature.size} 种不同的启动方式。指向旧路径的那几个会在握手时失败，Agent 里表现为「MCP 已注册但用不了」。`,
      fix: '到「MCP」页找到这个 server，用「统一为此配置」把所有 Agent 对齐到正确的那一份（写入前自动备份）。',
    });
  }

  // 3. Skill issues.
  const skills = await scanUnifiedSkills(env, adapters);
  for (const skill of skills) {
    // Dedupe by path: shared dirs (pool, ~/.claude/skills) are scanned for
    // several agents — one physical link/copy is one issue, not N.
    const brokenSeen = new Set<string>();
    for (const loc of skill.locations) {
      if (loc.kind === 'link' && loc.linkOk === false && !brokenSeen.has(loc.path)) {
        brokenSeen.add(loc.path);
        issues.push({
          kind: 'broken-skill-link',
          severity: 'warn',
          message: `skill「${skill.name}」在 ${loc.agent} 的链接已失效`,
          detail: `${loc.path} → ${loc.linkTarget ?? '?'}`,
          subject: skill.name,
          paths: [loc.path],
          why: '这是一个符号链接，它指向的实体目录已经不在了（被移动或删除），该 Agent 加载这个 skill 会失败。',
          fix: '点「清理失效 skill 链接」删掉这个空链接——只删链接本身，不会碰任何实体文件。',
        });
      }
    }
    const realPaths = new Set(skill.locations.filter((l) => l.kind === 'real').map((l) => l.path));
    if (realPaths.size > 1) {
      const where = [...new Set(skill.locations.filter((l) => l.kind === 'real').map((l) => l.agent))].join(', ');
      issues.push({
        kind: 'duplicate-skill-real',
        severity: 'warn',
        message: `skill「${skill.name}」存在 ${realPaths.size} 份实体拷贝（应保留一份，其余用链接）`,
        detail: where,
        subject: skill.name,
        paths: [...realPaths],
        why: '同名 skill 有多份各自独立的真实文件。改了其中一份，其他 Agent 读到的还是旧的，久了就会各说各话。',
        fix: '不影响当前使用，Agora 绝不会自动删实体文件。想收敛的话：自己保留内容最新的一份，删掉其余目录，再在「Skills」矩阵里给对应 Agent 打勾（改为链接）。',
      });
    }
  }

  const order = { error: 0, warn: 1 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

export async function configHomeExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
