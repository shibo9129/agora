import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters } from '@agora/adapters';
import {
  checkUpdates,
  installSkill,
  listInstalled,
  parseGitUrl,
  storeRoot,
  uninstallSkill,
  updateSkill,
} from '../index.js';

let root: string;
let remote: string; // local "remote" git repo acting as the skill source
let env: { home: string; env: NodeJS.ProcessEnv };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
}

function writeSkill(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${version}\n---\n\n# ${name} ${version}\n`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-m5-'));
  process.env['AGORA_HOME'] = join(root, 'agora-home');
  env = { home: root, env: { AGORA_HOME: join(root, 'agora-home') } };

  // Build a local git "remote" containing two skills.
  remote = join(root, 'remote-repo');
  mkdirSync(remote);
  git(['init', '-q', '-b', 'main'], remote);
  git(['config', 'user.email', 'test@agora.local'], remote);
  git(['config', 'user.name', 'Agora Test'], remote);
  writeSkill(join(remote, 'skills/git-alpha'), 'git-alpha', 'v1');
  writeSkill(join(remote, 'solo'), 'solo', 'v1');
  git(['add', '.'], remote);
  git(['commit', '-q', '-m', 'v1'], remote);

  // Agent dirs the store will link into.
  mkdirSync(join(root, '.codex/skills'), { recursive: true });
});

afterAll(() => {
  delete process.env['AGORA_HOME'];
  rmSync(root, { recursive: true, force: true });
});

describe('git url parsing', () => {
  it('parses plain, #subdir, and /tree/ forms', () => {
    expect(parseGitUrl('https://github.com/o/r')).toEqual({ url: 'https://github.com/o/r' });
    expect(parseGitUrl('https://github.com/o/r#skills/x')).toEqual({ url: 'https://github.com/o/r', subdir: 'skills/x' });
    expect(parseGitUrl('https://github.com/o/r/tree/main/skills/x')).toEqual({ url: 'https://github.com/o/r', subdir: 'skills/x' });
  });
  it('rejects non-https remotes', () => {
    expect(() => parseGitUrl('git@github.com:o/r.git')).toThrow('https');
  });
});

describe('install / update / uninstall', () => {
  it('installs all skills from a git repo and links one into codex', async () => {
    const result = await installSkill({ type: 'git', url: remote }, { linkTo: ['codex'] }, env, builtinAdapters);
    expect(result.installed.map((s) => s.name).sort()).toEqual(['git-alpha', 'solo']);
    expect(existsSync(join(storeRoot(), 'git-alpha/SKILL.md'))).toBe(true);
    // Linked into codex
    const link = join(root, '.codex/skills/git-alpha');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(storeRoot(), 'git-alpha'));

    const installed = await listInstalled();
    expect(installed.length).toBe(2);
    expect(installed[0]!.source.type).toBe('git');
  });

  it('installs only a subdirectory when subdir is given', async () => {
    const result = await installSkill({ type: 'git', url: `${remote}#skills` }, {}, env, builtinAdapters);
    // skills/ contains only git-alpha
    expect(result.installed.map((s) => s.name)).toEqual(['git-alpha']);
  });

  it('detects and applies an update from the remote', async () => {
    // No update yet.
    let statuses = await checkUpdates();
    const alpha = statuses.find((s) => s.name === 'git-alpha')!;
    expect(alpha.updateAvailable).toBe(false);

    // Push v2 to the remote.
    writeSkill(join(remote, 'skills/git-alpha'), 'git-alpha', 'v2');
    git(['add', '.'], remote);
    git(['commit', '-q', '-m', 'v2'], remote);

    statuses = await checkUpdates();
    const stale = statuses.find((s) => s.name === 'git-alpha')!;
    expect(stale.updateAvailable).toBe(true);
    expect(stale.remoteStamp).not.toBe(stale.currentStamp);

    await updateSkill('git-alpha', env, builtinAdapters);
    const content = readFileSync(join(storeRoot(), 'git-alpha/SKILL.md'), 'utf-8');
    expect(content).toContain('v2');
    const after = await checkUpdates();
    expect(after.find((s) => s.name === 'git-alpha')!.updateAvailable).toBe(false);
  });

  it('uninstalls: removes links, store dir, and manifest entry', async () => {
    const { unlinked, removed } = await uninstallSkill('git-alpha', env, builtinAdapters);
    expect(removed).toBe(true);
    expect(unlinked).toContain('codex');
    expect(existsSync(join(storeRoot(), 'git-alpha'))).toBe(false);
    expect(existsSync(join(root, '.codex/skills/git-alpha'))).toBe(false);
    const installed = await listInstalled();
    expect(installed.map((s) => s.name)).toEqual(['solo']);
  });

  it('rejects sources with escaping symlinks', async () => {
    const evil = join(root, 'evil-repo');
    mkdirSync(evil);
    git(['init', '-q', '-b', 'main'], evil);
    git(['config', 'user.email', 'test@agora.local'], evil);
    git(['config', 'user.name', 'Agora Test'], evil);
    mkdirSync(join(evil, 'evil-skill'));
    writeFileSync(join(evil, 'evil-skill/SKILL.md'), '---\nname: evil-skill\n---\n');
    execFileSync('ln', ['-s', '/etc/passwd', join(evil, 'evil-skill/pwnd')]);
    git(['add', '.'], evil);
    git(['commit', '-q', '-m', 'evil'], evil);

    const result = await installSkill({ type: 'git', url: evil }, {}, env, builtinAdapters);
    expect(result.installed.length).toBe(0);
    expect(result.skipped.some((s) => s.reason.includes('逃逸'))).toBe(true);
  });
});

it('rejects a different source with the same skill name', async () => {
  const one = join(root, 'one/duplicate'); const two = join(root, 'two/duplicate');
  writeSkill(one, 'duplicate', 'original'); writeSkill(two, 'duplicate', 'replacement');
  await installSkill({ type: 'local', path: one });
  const result = await installSkill({ type: 'local', path: two });
  expect(result.installed).toHaveLength(0);
  expect(result.skipped[0]?.reason).toContain('拒绝覆盖');
  expect(readFileSync(join(storeRoot(), 'duplicate/SKILL.md'), 'utf8')).toContain('original');
});
