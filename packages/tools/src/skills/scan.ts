/**
 * Skill scanner: walks every adapter's skillDirs, parses SKILL.md
 * frontmatter, and merges everything into a unified view.
 *
 * Read-only — never mutates skill directories.
 */

import matter from 'gray-matter';
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import type { SkillLocation, UnifiedSkill } from '../types.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  origin?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function parseSkillMd(dir: string): Promise<SkillFrontmatter> {
  try {
    const raw = await readFile(join(dir, 'SKILL.md'), 'utf-8');
    const { data } = matter(raw);
    const fm: SkillFrontmatter = {};
    if (typeof data['name'] === 'string') fm.name = data['name'];
    if (typeof data['description'] === 'string') fm.description = data['description'];
    if (typeof data['origin'] === 'string') fm.origin = data['origin'];
    return fm;
  } catch {
    return {};
  }
}

/** Scan one adapter's skill dirs into locations (one per skill found). */
export async function scanSkillLocations(
  adapter: AgentAdapter,
  env?: AdapterEnv,
): Promise<(SkillLocation & { dirName: string; fm: SkillFrontmatter })[]> {
  if (!adapter.skillDirs) return [];
  const out: (SkillLocation & { dirName: string; fm: SkillFrontmatter })[] = [];
  for (const dir of adapter.skillDirs(env)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let kind: 'real' | 'link' = 'real';
      let linkTarget: string | undefined;
      let linkOk: boolean | undefined;
      if (entry.isSymbolicLink()) {
        kind = 'link';
        try {
          linkTarget = await readlink(full);
          const st = await stat(full);
          isDir = st.isDirectory();
          linkOk = true;
        } catch {
          linkOk = false;
          isDir = true; // treat broken link as dir-ish for reporting
        }
      }
      if (!isDir) continue;
      // A skill dir must contain SKILL.md (broken links may not).
      const hasManifest = kind === 'link' && linkOk === false ? false : await pathExists(join(full, 'SKILL.md'));
      if (!hasManifest && !(kind === 'link' && linkOk === false)) continue;
      const fm = hasManifest ? await parseSkillMd(full) : {};
      const loc: SkillLocation & { dirName: string; fm: SkillFrontmatter } = {
        agent: adapter.id,
        path: full,
        kind,
        dirName: entry.name,
        fm,
      };
      if (linkTarget !== undefined) loc.linkTarget = linkTarget;
      if (linkOk !== undefined) loc.linkOk = linkOk;
      out.push(loc);
    }
  }
  return out;
}

/** Merge all adapters' skill locations into the unified view. */
export async function scanUnifiedSkills(
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<UnifiedSkill[]> {
  const perAgent = await Promise.all(adapters.map((a) => scanSkillLocations(a, env)));
  const byName = new Map<string, UnifiedSkill>();

  for (const locations of perAgent) {
    for (const loc of locations) {
      const name = loc.fm.name ?? loc.dirName;
      let skill = byName.get(name);
      if (!skill) {
        skill = { name, locations: [] };
        if (loc.fm.description) skill.description = loc.fm.description;
        if (loc.fm.origin) skill.origin = loc.fm.origin;
        byName.set(name, skill);
      }
      if (!skill.description && loc.fm.description) skill.description = loc.fm.description;
      if (!skill.origin && loc.fm.origin) skill.origin = loc.fm.origin;
      const location: SkillLocation = {
        agent: loc.agent,
        path: loc.path,
        kind: loc.kind,
      };
      if (loc.linkTarget !== undefined) location.linkTarget = loc.linkTarget;
      if (loc.linkOk !== undefined) location.linkOk = loc.linkOk;
      skill.locations.push(location);
    }
  }

  for (const skill of byName.values()) {
    // Note: the same path may legitimately appear under several agents — the
    // shared pool (~/.agents/skills) and ~/.claude/skills are read by multiple
    // agents (pi, OpenCode). Locations are kept per-agent on purpose; health
    // checks dedupe by path when counting copies.
    // Source of truth preference: Agora store (hub-installed) > shared pool >
    // any other real location > whatever exists.
    skill.realLocation =
      skill.locations.find((l) => l.kind === 'real' && l.agent === 'agora-store') ??
      skill.locations.find((l) => l.kind === 'real' && l.agent === 'shared-pool') ??
      skill.locations.find((l) => l.kind === 'real') ??
      skill.locations[0];
    skill.locations.sort((a, b) => a.agent.localeCompare(b.agent));
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
