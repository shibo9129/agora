/**
 * Managed blocks inside agent entry files (AGENTS.md / CLAUDE.md / SOUL.md).
 *
 * Pattern (ECC-style): content owned by Agora lives between explicit markers;
 * everything outside the markers is the user's and is never touched. Every
 * write is preceded by a .bak backup and recorded in an ownership manifest
 * so unenroll can cleanly remove exactly what we added.
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';

const BEGIN = (id: string): string => `<!-- BEGIN AGORA-MANAGED:${id} -->`;
const END = (id: string): string => `<!-- END AGORA-MANAGED:${id} -->`;

export interface ManagedBlock {
  blockId: string;
  filePath: string;
  present: boolean;
}

function manifestPath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'hub-manifest.json');
}

export interface OwnershipManifest {
  /** filePath → blockIds we manage there */
  files: Record<string, string[]>;
}

export async function readManifest(): Promise<OwnershipManifest> {
  try {
    const raw = await readFile(manifestPath(), 'utf-8');
    const parsed = JSON.parse(raw) as OwnershipManifest;
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    // fallthrough
  }
  return { files: {} };
}

async function writeManifest(m: OwnershipManifest): Promise<void> {
  await mkdir(dirname(manifestPath()), { recursive: true });
  await writeFile(manifestPath(), JSON.stringify(m, null, 2) + '\n', 'utf-8');
}

async function recordBlock(filePath: string, blockId: string): Promise<void> {
  const m = await readManifest();
  const list = m.files[filePath] ?? [];
  if (!list.includes(blockId)) {
    list.push(blockId);
    m.files[filePath] = list;
    await writeManifest(m);
  }
}

async function dropBlock(filePath: string, blockId: string): Promise<void> {
  const m = await readManifest();
  const list = (m.files[filePath] ?? []).filter((b) => b !== blockId);
  if (list.length === 0) delete m.files[filePath];
  else m.files[filePath] = list;
  await writeManifest(m);
}

async function backup(path: string): Promise<string> {
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(path, backupPath);
  return backupPath;
}

export function hasManagedBlock(content: string, blockId: string): boolean {
  return content.includes(BEGIN(blockId));
}

function replaceBlock(content: string, blockId: string, body: string): string {
  const begin = BEGIN(blockId);
  const end = END(blockId);
  const startIdx = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`受管区块标记损坏: ${blockId}`);
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + end.length);
  return `${before}${begin}\n${body.trim()}\n${end}${after}`;
}

/** Insert or replace a managed block. Creates the file when missing.
 *  Noop (no backup, no write) when the block already has identical content. */
export async function upsertManagedBlock(
  filePath: string,
  blockId: string,
  body: string,
): Promise<{ action: 'inserted' | 'replaced' | 'noop'; backupPath?: string }> {
  const block = `${BEGIN(blockId)}\n${body.trim()}\n${END(blockId)}`;
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${block}\n`, 'utf-8');
    await recordBlock(filePath, blockId);
    return { action: 'inserted' };
  }
  const content = await readFile(filePath, 'utf-8');
  if (hasManagedBlock(content, blockId)) {
    const begin = BEGIN(blockId);
    const end = END(blockId);
    const startIdx = content.indexOf(begin);
    const endIdx = content.indexOf(end);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const currentBody = content.slice(startIdx + begin.length, endIdx).trim();
      if (currentBody === body.trim()) {
        return { action: 'noop' }; // already up to date — leave the file untouched
      }
    }
  }
  const backupPath = await backup(filePath);
  let next: string;
  if (hasManagedBlock(content, blockId)) {
    next = replaceBlock(content, blockId, body);
  } else {
    const sep = content.endsWith('\n') ? '\n' : '\n\n';
    next = `${content}${sep}${block}\n`;
  }
  await writeFile(filePath, next, 'utf-8');
  await recordBlock(filePath, blockId);
  return { action: hasManagedBlock(content, blockId) ? 'replaced' : 'inserted', backupPath };
}

/** Remove a managed block (file itself and other content stay). */
export async function removeManagedBlock(
  filePath: string,
  blockId: string,
): Promise<{ action: 'removed' | 'noop'; backupPath?: string }> {
  if (!existsSync(filePath)) return { action: 'noop' };
  const content = await readFile(filePath, 'utf-8');
  if (!hasManagedBlock(content, blockId)) return { action: 'noop' };
  const backupPath = await backup(filePath);
  const begin = BEGIN(blockId);
  const end = END(blockId);
  const startIdx = content.indexOf(begin);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`受管区块标记损坏: ${blockId}`);
  }
  let next = `${content.slice(0, startIdx)}${content.slice(endIdx + end.length)}`;
  // Collapse >2 consecutive blank lines left behind.
  next = next.replace(/\n{3,}/g, '\n\n');
  await writeFile(filePath, next, 'utf-8');
  await dropBlock(filePath, blockId);
  return { action: 'removed', backupPath };
}

export async function listManagedBlocks(): Promise<ManagedBlock[]> {
  const m = await readManifest();
  const out: ManagedBlock[] = [];
  for (const [filePath, blockIds] of Object.entries(m.files)) {
    let content = '';
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      // file gone
    }
    for (const blockId of blockIds) {
      out.push({ blockId, filePath, present: content.includes(BEGIN(blockId)) });
    }
  }
  return out;
}
