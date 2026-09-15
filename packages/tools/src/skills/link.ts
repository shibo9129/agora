/**
 * Skill enable/disable via symlinks: enabling a skill for an agent creates a
 * symlink in that agent's skill dir pointing at the skill's real location;
 * disabling removes the link. Real files are never moved or deleted by
 * toggle operations.
 */

import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import { scanUnifiedSkills } from './scan.js';
import type { UnifiedSkill } from '../types.js';

export class SkillToggleError extends Error {}

function primarySkillDir(adapter: AgentAdapter, env?: AdapterEnv): string {
  const dirs = adapter.skillDirs?.(env);
  if (!dirs || dirs.length === 0) {
    throw new SkillToggleError(`Agent ${adapter.id} 不支持 skills`);
  }
  return dirs[0]!;
}

export interface SkillToggleResult {
  skill: string;
  agent: string;
  action: 'enabled' | 'disabled' | 'noop';
  detail: string;
}

async function isSkillPresent(dir: string, name: string): Promise<{ present: boolean; kind?: 'real' | 'link' }> {
  try {
    const st = await lstat(join(dir, name));
    return { present: true, kind: st.isSymbolicLink() ? 'link' : 'real' };
  } catch {
    return { present: false };
  }
}

export async function setSkillEnabled(
  skillName: string,
  agentId: string,
  enable: boolean,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<SkillToggleResult> {
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new SkillToggleError(`未知 agent: ${agentId}`);
  const targetDir = primarySkillDir(adapter, env);

  const skills = await scanUnifiedSkills(env, adapters);
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) throw new SkillToggleError(`未知 skill: ${skillName}`);

  const existing = skill.locations.find((l) => l.agent === agentId);
  if (enable && existing && existing.kind === 'real') {
    return { skill: skillName, agent: agentId, action: 'noop', detail: '该 agent 已有实体安装' };
  }
  if (!enable && !existing) {
    return { skill: skillName, agent: agentId, action: 'noop', detail: '本未启用' };
  }

  if (enable) {
    if (!skill.realLocation) throw new SkillToggleError(`skill ${skillName} 没有实体位置可链接`);
    await mkdir(targetDir, { recursive: true });
    const linkPath = join(targetDir, skillName);
    const { present } = await isSkillPresent(targetDir, skillName);
    if (present) {
      // Replace stale/broken link only.
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) throw new SkillToggleError(`${linkPath} 已存在且非链接，拒绝覆盖`);
      await rm(linkPath);
    }
    await symlink(skill.realLocation.path, linkPath, 'dir');
    return { skill: skillName, agent: agentId, action: 'enabled', detail: `已链接到 ${skill.realLocation.path}` };
  }

  // disable: only remove symlinks — real files stay untouched.
  if (!existing) return { skill: skillName, agent: agentId, action: 'noop', detail: '本未启用' };
  if (existing.kind !== 'link') {
    throw new SkillToggleError(`${skillName} 在 ${agentId} 是实体安装，为保护数据不移除（仅可移除链接）`);
  }
  await rm(existing.path);
  return { skill: skillName, agent: agentId, action: 'disabled', detail: '已移除链接' };
}

/** Broken-link repair: remove skill symlinks whose targets vanished. */
export async function pruneBrokenSkillLinks(
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const skills = await scanUnifiedSkills(env, adapters);
  const seen = new Set<string>();
  for (const skill of skills) {
    for (const loc of skill.locations) {
      if (loc.kind !== 'link' || loc.linkOk !== false) continue;
      if (seen.has(loc.path)) continue;
      seen.add(loc.path);
      // Double-check it is still a symlink before removing.
      try {
        const st = await lstat(loc.path);
        if (!st.isSymbolicLink()) continue;
        await readlink(loc.path); // readable link itself
        await rm(loc.path);
        removed.push(loc.path);
      } catch {
        // vanished between scan and prune — fine
      }
    }
  }
  return { removed };
}

export type { UnifiedSkill };
