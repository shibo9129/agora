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
    const r = await setSkillEnabled('alpha', 'shared-pool', true, env, builtinAdapters);
    expect(r.action).toBe('noop');
  });

  it('refuses to remove a real install (data protection)', async () => {
    await expect(setSkillEnabled('gamma', 'claude-code', false, env, builtinAdapters)).rejects.toThrow('实体安装');
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
