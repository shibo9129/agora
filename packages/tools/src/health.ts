/**
 * Health checks: MCP drift, broken skill links, declared-but-missing config
 * homes, duplicate real skill installs.
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
        });
      }
    } catch {
      // detection failure is not an issue by itself
    }
  }

  // 2. MCP drift: same server name registered with different signatures.
  const servers = await scanUnifiedMcpServers(env, adapters);
  for (const server of servers) {
    if (server.drift) {
      const where = server.registrations.map((r) => r.agent).join(', ');
      issues.push({
        kind: 'mcp-drift',
        severity: 'error',
        message: `MCP「${server.name}」在多个 Agent 中配置不一致`,
        detail: where,
      });
    }
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
