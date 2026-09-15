import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listManagedBlocks, removeManagedBlock, upsertManagedBlock } from '../index.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-hub-blocks-'));
  process.env['AGORA_HOME'] = join(dir, 'agora-home');
});

afterAll(() => {
  delete process.env['AGORA_HOME'];
  rmSync(dir, { recursive: true, force: true });
});

const GUIDE = '## Agora 本地 AI 中枢\n\n使用说明正文';

describe('managed blocks', () => {
  const file = () => join(dir, 'AGENTS.md');

  it('creates a new entry file with the block', async () => {
    const r = await upsertManagedBlock(file(), 'agora-hub', GUIDE);
    expect(r.action).toBe('inserted');
    const content = readFileSync(file(), 'utf-8');
    expect(content).toContain('<!-- BEGIN AGORA-MANAGED:agora-hub -->');
    expect(content).toContain(GUIDE);
    expect(content).toContain('<!-- END AGORA-MANAGED:agora-hub -->');
  });

  it('appends to an existing file without touching user content, with backup', async () => {
    writeFileSync(file(), '# 用户自己的说明\n\n保持不动。\n');
    const r = await upsertManagedBlock(file(), 'agora-hub', GUIDE);
    expect(r.backupPath).toBeDefined();
    expect(existsSync(r.backupPath!)).toBe(true);
    const content = readFileSync(file(), 'utf-8');
    expect(content).toContain('# 用户自己的说明');
    expect(content).toContain('保持不动。');
    expect(content).toContain('BEGIN AGORA-MANAGED:agora-hub');
  });

  it('replaces only the managed block on update', async () => {
    const before = readFileSync(file(), 'utf-8');
    expect(before).toContain('保持不动。');
    await upsertManagedBlock(file(), 'agora-hub', '## 新版本指引');
    const content = readFileSync(file(), 'utf-8');
    expect(content).toContain('## 新版本指引');
    expect(content).not.toContain('使用说明正文');
    expect(content).toContain('保持不动。');
    expect(content.match(/BEGIN AGORA-MANAGED:agora-hub/g)!.length).toBe(1);
  });

  it('removes the block and preserves the rest', async () => {
    const r = await removeManagedBlock(file(), 'agora-hub');
    expect(r.action).toBe('removed');
    const content = readFileSync(file(), 'utf-8');
    expect(content).toContain('保持不动。');
    expect(content).not.toContain('AGORA-MANAGED');
  });

  it('is a noop when the block is absent', async () => {
    const r = await removeManagedBlock(file(), 'agora-hub');
    expect(r.action).toBe('noop');
  });

  it('tracks ownership in the manifest', async () => {
    await upsertManagedBlock(file(), 'agora-hub', 'x');
    const blocks = await listManagedBlocks();
    expect(blocks.some((b) => b.blockId === 'agora-hub' && b.filePath === file() && b.present)).toBe(true);
    await removeManagedBlock(file(), 'agora-hub');
    const after = await listManagedBlocks();
    expect(after.some((b) => b.filePath === file())).toBe(false);
  });
});
