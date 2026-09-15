/**
 * Agent memory sync: scan each real agent's memoryDirs for .md files and
 * converge them into the hub store under `synced/<agentId>/…`.
 *
 * "Refinement" here is deterministic (no LLM): title from frontmatter/first
 * heading/filename, abstract from frontmatter/first non-empty paragraph
 * (truncated), body kept up to a size cap. Source files are never modified.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import type { MemoryStore } from './store.js';

const SKIP_FILES = new Set(['MEMORY.md', 'memory_summary.md']);
const SKIP_DIRS = new Set(['extensions', 'xcrun_db', 'node_modules', '.git']);
const MAX_BODY_CHARS = 6000;
const MAX_ABSTRACT_CHARS = 160;

interface MemoryFile {
  absPath: string;
  relPath: string;
}

async function collectMdFiles(dir: string, rel = '', depth = 0): Promise<MemoryFile[]> {
  if (depth > 4) return [];
  const out: MemoryFile[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.bak') || e.name.endsWith('.lock')) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await collectMdFiles(join(dir, e.name), childRel, depth + 1)));
    } else if (e.isFile() && e.name.endsWith('.md') && !SKIP_FILES.has(e.name)) {
      out.push({ absPath: join(dir, e.name), relPath: childRel });
    }
  }
  return out;
}

function extractTitle(data: Record<string, unknown>, body: string, fallback: string): string {
  if (typeof data['name'] === 'string' && data['name'].trim().length > 0) return data['name'].trim();
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1]!.trim();
  return fallback;
}

function extractAbstract(data: Record<string, unknown>, body: string, fallbackTitle: string): string {
  if (typeof data['abstract'] === 'string' && data['abstract'].trim().length > 0) {
    return data['abstract'].trim().slice(0, MAX_ABSTRACT_CHARS);
  }
  // First non-empty content line, skipping headings, quotes, HTML comments,
  // and machine metadata lines (threadid:/session-id: style).
  const metaRe = /^[\w-]+\s*[:=]\s*[\w:-]{6,}$/i;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#') || t.startsWith('>') || t.startsWith('<!--')) continue;
    if (metaRe.test(t)) continue;
    const text = t.replace(/[`*_]/g, '');
    if (text.length > 8) return text.slice(0, MAX_ABSTRACT_CHARS);
  }
  return fallbackTitle;
}

function slugify(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72); // leaves room for the -xxxxxx source-hash suffix (≤80 total)
}

export interface AgentSyncStat {
  agent: string;
  found: number;
  synced: number;
  skipped: { path: string; reason: string }[];
}

export interface SyncReport {
  agents: AgentSyncStat[];
  totalSynced: number;
  syncedAt: string;
}

export async function syncAgentMemories(
  store: MemoryStore,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<SyncReport> {
  const report: SyncReport = { agents: [], totalSynced: 0, syncedAt: new Date().toISOString() };
  for (const adapter of adapters) {
    if (!adapter.memoryDirs || adapter.id === 'shared-pool' || adapter.id === 'agora-store') continue;
    const stat: AgentSyncStat = { agent: adapter.id, found: 0, synced: 0, skipped: [] };
    for (const dir of adapter.memoryDirs(env)) {
      const files = await collectMdFiles(dir);
      stat.found += files.length;
      for (const file of files) {
        try {
          const content = await readFile(file.absPath, 'utf-8');
          if (content.trim().length < 24) {
            stat.skipped.push({ path: file.relPath, reason: '内容过少' });
            continue;
          }
          let fmData: Record<string, unknown> = {};
          let bodyContent = content;
          try {
            const parsed = matter(content);
            fmData = parsed.data as Record<string, unknown>;
            bodyContent = parsed.content;
          } catch {
            // no/invalid frontmatter — whole file is body
          }
          const fallbackName = file.relPath.split('/').pop()!.replace(/\.md$/i, '');
          const title = extractTitle(fmData, bodyContent, fallbackName);
          const abstract = extractAbstract(fmData, bodyContent, title);
          const body = bodyContent.trim().slice(0, MAX_BODY_CHARS);
          const fromHash = createHash('sha1').update(file.absPath).digest('hex').slice(0, 6);
          const entryName = `${slugify(title)}-${fromHash}`;
          const entryPath = `synced/${adapter.id}/${entryName}.md`;
          // The store's optimistic lock requires the current revision for
          // overwrite updates; read it first (null = new entry).
          const existing = await store.read(entryPath);
          await store.write({
            scope: 'synced',
            group: adapter.id,
            name: entryName,
            abstract,
            body: `> 来源：${adapter.displayName} · \`${file.absPath}\`\n\n${body}`,
            type: 'note',
            by: adapter.id,
            ...(existing ? { expectedRevision: existing.revision } : {}),
          });
          stat.synced++;
        } catch (err) {
          stat.skipped.push({ path: file.relPath, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    report.agents.push(stat);
    report.totalSynced += stat.synced;
  }
  return report;
}
