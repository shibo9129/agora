import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters } from '@agora/adapters';
import { scanUnifiedSkills, setSkillEnabled, pruneBrokenSkillLinks } from '../index.js';

let root: string;
let env: { home: string; env: NodeJS.ProcessEnv };

function makeSkill(dir: string, name: string, description?: string): void {
  mkdirSync(dir, { recursive: true });
  const fm = description ? `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` : `---\nname: ${name}\n---\n`;
  writeFileSync(join(dir, 'SKILL.md'), fm);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-tools-skills-'));
  env = { home: root, env: {} };

  // shared pool: two real skills
  makeSkill(join(root, '.agents/skills/alpha'), 'alpha', 'Alpha skill');
  makeSkill(join(root, '.agents/skills/beta'), 'beta', 'Beta skill');
  // claude: one real skill (its own copy) + a link to shared alpha + a broken link
  makeSkill(join(root, '.claude/skills/gamma'), 'gamma', 'Gamma skill');
  symlinkSync(join(root, '.agents/skills/alpha'), join(root, '.claude/skills').replace(/$/, '') + '/alpha-link-check');
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  symlinkSync(join(root, '.agents/skills/alpha'), join(root, '.claude/skills/alpha'), 'dir');
  symlinkSync(join(root, '.agents/skills/ghost'), join(root, '.claude/skills/ghost'), 'dir');
  // codex: no skills at all
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('skill scan', () => {
  it('merges skills across agents into a unified view', async () => {
    const skills = await scanUnifiedSkills(env, builtinAdapters);
    const names = skills.map((s) => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
    const alpha = skills.find((s) => s.name === 'alpha')!;
    expect(alpha.description).toBe('Alpha skill');
    expect(alpha.locations.some((l) => l.agent === 'shared-pool' && l.kind === 'real')).toBe(true);
    expect(alpha.locations.some((l) => l.agent === 'claude-code' && l.kind === 'link')).toBe(true);
    // Shared paths are reported for every agent that reads them (pi, OpenCode).
    expect(alpha.locations.some((l) => l.agent === 'pi' && l.path.includes('.agents/skills'))).toBe(true);
    expect(alpha.locations.some((l) => l.agent === 'opencode' && l.path.includes('.agents/skills'))).toBe(true);
    expect(alpha.realLocation!.agent).toBe('shared-pool');
  });

  it('marks broken links', async () => {
    const skills = await scanUnifiedSkills(env, builtinAdapters);
    const ghost = skills.find((s) => s.name === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.locations[0]!.kind).toBe('link');
    expect(ghost!.locations[0]!.linkOk).toBe(false);
  });
});

describe('skill toggle', () => {
  it('enables a skill via symlink and disables by removing it', async () => {
    const r1 = await setSkillEnabled('beta', 'codex', true, env, builtinAdapters);
    expect(r1.action).toBe('enabled');
    const linkPath = join(root, '.codex/skills/beta');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(root, '.agents/skills/beta'));

    const r2 = await setSkillEnabled('beta', 'codex', false, env, builtinAdapters);
    expect(r2.action).toBe('disabled');
    expect(existsSync(linkPath)).toBe(false);
  });

  it('is a noop when enabling a real install', async () => {
    const r = await setSkillEnabled('alpha', 'pi', true, env, builtinAdapters);
    expect(r.action).toBe('noop');
  });

  it('is a noop when a healthy link already exists for that agent', async () => {
    // alpha is already linked into .claude/skills (see fixture)
    const r = await setSkillEnabled('alpha', 'claude-code', true, env, builtinAdapters);
    expect(r.action).toBe('noop');
    expect(r.detail).toContain('已启用');
  });

  it('refuses to create a self-referential link inside the skill\'s own home', async () => {
    // A broken link inside the pool whose only "location" is that link itself.
    const delta = join(root, '.agents/skills/delta');
    symlinkSync(join(root, '.agents/skills/missing-ghost-x'), delta, 'dir');
    try {
      await expect(setSkillEnabled('delta', 'pi', true, env, builtinAdapters)).rejects.toThrow('没有实体');
    } finally {
      rmSync(delta, { force: true });
    }
  });

  it('refuses to remove a real install (data protection)', async () => {
    await expect(setSkillEnabled('gamma', 'claude-code', false, env, builtinAdapters)).rejects.toThrow('实体安装');
  });

  it('refuses to link a new agent off another agent\'s own (healthy) link — no stable target to chain onto', async () => {
    // epsilon exists for real only outside any adapter's skillDirs; codex's
    // own skills dir merely links to it (mirrors how e.g. a codex plugin
    // manager exposes its cache under ~/.codex/skills as a symlink). Without
    // a genuine 'real' location, enabling epsilon elsewhere must fail rather
    // than link onto codex's link — that link is codex's to move/remove, and
    // a link-onto-link snaps the moment codex reorganizes it.
    makeSkill(join(root, 'external-cache/epsilon'), 'epsilon', 'Epsilon skill');
    mkdirSync(join(root, '.codex/skills'), { recursive: true });
    symlinkSync(join(root, 'external-cache/epsilon'), join(root, '.codex/skills/epsilon'), 'dir');
    try {
      const skills = await scanUnifiedSkills(env, builtinAdapters);
      const epsilon = skills.find((s) => s.name === 'epsilon')!;
      expect(epsilon.locations.every((l) => l.kind === 'link')).toBe(true);
      expect(epsilon.realLocation).toBeUndefined();
      await expect(setSkillEnabled('epsilon', 'claude-code', true, env, builtinAdapters)).rejects.toThrow('没有实体位置可链接');
    } finally {
      rmSync(join(root, '.codex/skills/epsilon'), { force: true });
      rmSync(join(root, 'external-cache'), { recursive: true, force: true });
    }
  });
});

describe('broken link repair', () => {
  it('prunes broken symlinks only', async () => {
    const { removed } = await pruneBrokenSkillLinks(env, builtinAdapters);
    expect(removed.length).toBe(1);
    expect(removed[0]).toContain('ghost');
    expect(existsSync(join(root, '.claude/skills/alpha'))).toBe(true); // good link kept
    expect(existsSync(join(root, '.claude/skills/gamma/SKILL.md'))).toBe(true); // real kept
  });
});
