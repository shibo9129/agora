/**
 * Central skill store: git/local installs land here as REAL files; agents
 * receive them via symlinks (M3 toggle semantics). Every install is recorded
 * in a manifest with its source, enabling update checks and clean uninstall.
 *
 * Update strategy: `git ls-remote` for a lightweight remote HEAD comparison
 * (no fetch needed to detect staleness), then a fresh shallow clone + swap.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, rename, readlink, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { promisify } from 'node:util';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import { setSkillEnabled } from './link.js';

const execFileAsync = promisify(execFile);

// ── Paths & manifest ───────────────────────────────────────────────────────

export function storeRoot(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'store', 'skills');
}

function manifestPath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'store', 'manifest.json');
}

export type SkillSource =
  | { type: 'git'; url: string; subdir?: string }
  | { type: 'local'; path: string };

export interface InstalledSkill {
  name: string;
  source: SkillSource;
  /** Last known remote/local commit or content stamp. */
  stamp: string;
  installedAt: string;
  updatedAt: string;
}

export interface StoreManifest {
  skills: Record<string, InstalledSkill>;
}

export async function readStoreManifest(): Promise<StoreManifest> {
  try {
    const raw = await readFile(manifestPath(), 'utf-8');
    const parsed = JSON.parse(raw) as StoreManifest;
    if (parsed && typeof parsed === 'object' && parsed.skills) return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { skills: {} };
}

async function writeStoreManifest(m: StoreManifest): Promise<void> {
  await mkdir(join(manifestPath(), '..'), { recursive: true });
  const temp = `${manifestPath()}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(m, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx', mode: 0o600 }); await rename(temp, manifestPath()); } finally { await rm(temp, { force: true }); }
}

// ── Git helpers ────────────────────────────────────────────────────────────

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never prompt for credentials
  });
  return stdout.trim();
}

/** Parse a git URL + optional `#subdir` or GitHub /tree/<branch>/<path> form. */
export function parseGitUrl(input: string): { url: string; subdir?: string } {
  let url = input.trim();
  let subdir: string | undefined;
  const hashIdx = url.indexOf('#');
  if (hashIdx !== -1) {
    subdir = url.slice(hashIdx + 1).replace(/^\/+|\/+$/g, '') || undefined;
    url = url.slice(0, hashIdx);
  }
  const treeMatch = url.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/[^/]+\/(.+)$/);
  if (treeMatch) {
    url = treeMatch[1]!;
    subdir = treeMatch[2]!.replace(/\/+$/g, '');
  }
  // Local paths (dev/test only) are allowed; everything else must be https.
  const isLocal = url.startsWith('/') || url.startsWith('file://');
  if (!isLocal && !url.startsWith('https://')) {
    throw new Error(`仅支持 https:// Git 地址（或本地路径）: ${input}`);
  }
  if (subdir && (subdir.split('/').includes('..') || subdir.includes('\\'))) throw new Error('Git 子目录路径逃逸');
  return subdir !== undefined ? { url, subdir } : { url };
}

/** Locate skill dirs (containing SKILL.md) inside a cloned/extracted tree. */
async function findSkillDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    if (existsSync(join(dir, 'SKILL.md'))) {
      out.push(dir);
      return; // don't descend into a skill
    }
    let entries;
    try {
      entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') {
        await walk(join(dir, e.name), depth + 1);
      }
    }
  };
  await walk(root, 0);
  return out;
}

function skillNameOf(dir: string): string {
  return dir.split('/').pop()!;
}

/** Sanity limits for installed content. */
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;

async function assertNoSymlinksEscape(dir: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    const { readdir, lstat } = await import('node:fs/promises');
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const target = await readlink(full);
        // Absolute targets resolve as-is; relative ones resolve against the
        // link's directory. path.join would wrongly prefix absolute targets.
        const resolved = target.startsWith('/') ? target : resolve(d, target);
        if (resolved !== dir && !resolved.startsWith(dir + '/')) {
          throw new Error(`skill 包含逃逸符号链接，拒绝安装: ${full}`);
        }
        const { realpath } = await import('node:fs/promises');
        const real = await realpath(full);
        if (real !== dir && !real.startsWith(dir + '/')) throw new Error('skill 包含逃逸符号链接');
      } else if (e.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(dir);
}

async function treeStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    const { readdir, lstat } = await import('node:fs/promises');
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files++;
        bytes += (await lstat(full)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function contentStamp(dir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const hash = createHash('sha256');
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, e.name);
      hash.update(relative(dir, full));
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) hash.update(await readFile(full));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

// ── Install / update / uninstall ───────────────────────────────────────────

export interface InstallResult {
  installed: InstalledSkill[];
  linkedTo: { skill: string; agent: string; action: string }[];
  skipped: { dir: string; reason: string }[];
}

async function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(join(storeRoot(), '..'), { recursive: true });
  const lock = join(storeRoot(), '..', '.mutation-lock');
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('工具仓库正在变更，请重试；异常退出后请检查 .mutation-lock');
    throw error;
  }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}

function sameSource(a: SkillSource, b: SkillSource): boolean {
  if (a.type !== b.type) return false;
  return a.type === 'git' && b.type === 'git' ? a.url === b.url && (a.subdir ?? '') === (b.subdir ?? '') : a.type === 'local' && b.type === 'local' && resolve(a.path) === resolve(b.path);
}

async function installFromTree(
  treeRoot: string,
  source: SkillSource,
  stamp: string,
  linkTo: readonly string[],
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
  updating?: string,
): Promise<InstallResult> {
  const skillDirs = await findSkillDirs(treeRoot);
  const result: InstallResult = { installed: [], linkedTo: [], skipped: [] };
  if (skillDirs.length === 0) {
    result.skipped.push({ dir: treeRoot, reason: '未发现 SKILL.md' });
    return result;
  }
  return withStoreLock(async () => {
  const manifest = await readStoreManifest();
  for (const dir of skillDirs) {
    if (updating && skillNameOf(dir) !== updating) continue;
    if (skillDirs.filter(d => skillNameOf(d) === skillNameOf(dir)).length !== 1) { result.skipped.push({ dir, reason: '来源中有多个同名 Skill，请选择具体子目录' }); continue; }
    const name = skillNameOf(dir);
    const leaf = relative(treeRoot, dir).split('\\').join('/');
    const installedSource: SkillSource = source.type === 'git' ? { type: 'git', url: source.url, ...([source.subdir, leaf].filter(Boolean).join('/') ? { subdir: [source.subdir, leaf].filter(Boolean).join('/') } : {}) } : { type: 'local', path: resolve(dir) };
    const target = join(storeRoot(), name);
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('非法 Skill 名称');
      const previous = Object.hasOwn(manifest.skills, name) ? manifest.skills[name] : undefined;
      const legacyUpdate = updating === name && previous && sameSource(previous.source, source);
      if (existsSync(target) && (!previous || (!sameSource(previous.source, installedSource) && !legacyUpdate))) throw new Error('同名 Skill 来自其他来源，拒绝覆盖；请先确认并卸载旧来源');
      await assertNoSymlinksEscape(dir);
      const stats = await treeStats(dir);
      if (stats.files > MAX_FILES || stats.bytes > MAX_BYTES) {
        result.skipped.push({ dir, reason: `超出大小限制（${stats.files} 文件 / ${stats.bytes} B）` });
        continue;
      }
      await mkdir(storeRoot(), { recursive: true });
      const contentHash = source.type === 'local' ? await contentStamp(dir) : stamp;
      const stage = await mkdtemp(join(storeRoot(), '.stage-'));
      const backup = join(storeRoot(), '..', 'history', `${name}-${randomUUID()}`);
      let backedUp = false;
      try {
        await cp(dir, stage, { recursive: true, verbatimSymlinks: true });
        if (existsSync(target)) {
          await mkdir(join(backup, '..'), { recursive: true });
          await rename(target, backup);
          backedUp = true;
        }
        try { await rename(stage, target); } catch (error) {
          if (backedUp) await rename(backup, target);
          throw error;
        }
      } finally { await rm(stage, { recursive: true, force: true }); }
      const now = new Date().toISOString();
      const prev = manifest.skills[name];
      const installed: InstalledSkill = {
        name,
        source: installedSource,
        stamp: contentHash,
        installedAt: prev?.installedAt ?? now,
        updatedAt: now,
      };
      manifest.skills[name] = installed;
      try { await writeStoreManifest(manifest); } catch (error) {
        if (previous) manifest.skills[name] = previous;
        else delete manifest.skills[name];
        await rm(target, { recursive: true, force: true });
        if (backedUp) await rename(backup, target);
        throw error;
      }
      result.installed.push(installed);
      for (const agent of linkTo) {
        try {
          const r = await setSkillEnabled(name, agent, true, env, adapters);
          result.linkedTo.push({ skill: name, agent, action: r.action });
        } catch (err) {
          result.linkedTo.push({ skill: name, agent, action: `failed: ${err instanceof Error ? err.message : err}` });
        }
      }
    } catch (err) {
      result.skipped.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
  });
}

export async function installSkill(
  source: SkillSource,
  options: { linkTo?: readonly string[]; updating?: string } = {},
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<InstallResult> {
  const linkTo = options.linkTo ?? [];
  if (source.type === 'local') {
    const abs = source.path;
    if (!existsSync(abs)) throw new Error(`本地路径不存在: ${abs}`);
    const stamp = await contentStamp(abs);
    return installFromTree(abs, { type: 'local', path: abs }, stamp, linkTo, env, adapters, options.updating);
  }

  const { url, subdir } = parseGitUrl(`${source.url}${source.subdir ? `#${source.subdir}` : ''}`);
  const tmp = await mkdtemp(join(tmpdir(), 'agora-skill-clone-'));
  try {
    await git(['clone', '--depth', '1', '--quiet', url, tmp]);
    const stamp = await git(['rev-parse', 'HEAD'], tmp);
    const treeRoot = subdir ? join(tmp, subdir) : tmp;
    if (!existsSync(treeRoot)) throw new Error(`仓库中不存在子目录: ${subdir}`);
    return await installFromTree(treeRoot, { type: 'git', url, ...(subdir ? { subdir } : {}) }, stamp, linkTo, env, adapters, options.updating);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ── Update checks ──────────────────────────────────────────────────────────

export interface UpdateStatus {
  name: string;
  source: SkillSource;
  currentStamp: string;
  remoteStamp?: string | undefined;
  updateAvailable: boolean;
  error?: string | undefined;
}

export async function checkUpdates(): Promise<UpdateStatus[]> {
  const manifest = await readStoreManifest();
  const out: UpdateStatus[] = [];
  for (const skill of Object.values(manifest.skills)) {
    const status: UpdateStatus = { name: skill.name, source: skill.source, currentStamp: skill.stamp, updateAvailable: false };
    try {
      if (skill.source.type === 'git') {
        const remote = await git(['ls-remote', skill.source.url, 'HEAD']);
        const remoteSha = remote.split('\t')[0] ?? '';
        status.remoteStamp = remoteSha;
        status.updateAvailable = remoteSha !== '' && remoteSha !== skill.stamp;
      } else {
        const stamp = existsSync(skill.source.path) ? await contentStamp(skill.source.path) : undefined;
        status.remoteStamp = stamp;
        status.updateAvailable = stamp !== undefined && stamp !== skill.stamp;
      }
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err);
    }
    out.push(status);
  }
  return out;
}

export async function updateSkill(
  name: string,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<InstallResult> {
  const manifest = await readStoreManifest();
  const skill = manifest.skills[name];
  if (!skill) throw new Error(`未安装的 skill: ${name}`);
  // Re-install from the same source; links keep pointing at the same path.
  return installSkill(skill.source, { linkTo: [], updating: name }, env, adapters);
}

export async function uninstallSkill(
  name: string,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<{ unlinked: string[]; removed: boolean; cleanupErrors: {path: string; error: string}[] }> {
  return withStoreLock(async () => {
  const manifest = await readStoreManifest();
  if (!Object.hasOwn(manifest.skills, name)) throw new Error(`未安装的 skill: ${name}`);
  const target = join(storeRoot(), name);
  const backup = join(storeRoot(), '..', 'history', `${name}-uninstalled-${randomUUID()}`);
  const removed = existsSync(target);
  if (removed) { await mkdir(join(backup, '..'), {recursive:true}); await rename(target, backup); }
  delete manifest.skills[name];
  try { await writeStoreManifest(manifest); } catch (error) {
    if (removed) await rename(backup, target);
    throw error;
  }
  // Only remove links that point to this exact store item; unrelated links stay.
  const unlinked: string[] = [];
  const cleanupErrors: {path: string; error: string}[] = [];
  for (const adapter of adapters) {
    for (const dir of adapter.skillDirs?.(env) ?? []) {
      const path = join(dir, name);
      try {
        if ((await lstat(path)).isSymbolicLink() && resolve(dir, await readlink(path)) === resolve(target)) {
          await rm(path);
          if (!unlinked.includes(adapter.id)) unlinked.push(adapter.id);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push({path, error:String(error)}); }
    }
  }
  return { unlinked, removed, cleanupErrors };
  });
}

export async function listInstalled(): Promise<InstalledSkill[]> {
  const manifest = await readStoreManifest();
  return Object.values(manifest.skills).sort((a, b) => a.name.localeCompare(b.name));
}
