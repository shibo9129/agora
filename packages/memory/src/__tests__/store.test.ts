import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryStore } from '../index.js';

let dir: string;
let db: Database.Database;
let store: MemoryStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-memory-'));
  db = new Database(':memory:');
  store = new MemoryStore(db, dir);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('memory store', () => {
  it('writes and reads a full document', async () => {
    const entry = await store.write({
      name: 'agora-design',
      abstract: 'Agora 采用 Markdown 真相 + SQLite 可删索引',
      body: '详细设计：文件为唯一事实源……',
      type: 'decision',
      group: 'decisions',
      by: 'codex',
    });
    expect(entry.path).toBe('global/decisions/agora-design.md');
    expect(existsSync(join(dir, 'global/decisions/agora-design.md'))).toBe(true);

    const doc = await store.read(entry.path);
    expect(doc).not.toBeNull();
    expect(doc!.body).toContain('详细设计');
    expect(doc!.by).toBe('codex');
    expect(doc!.type).toBe('decision');
  });

  it('rejects unsafe names', async () => {
    await expect(store.write({ name: '../evil', abstract: 'x', body: 'x' })).rejects.toThrow('非法');
  });

  it('searches with FTS (CJK) and LIKE fallback', async () => {
    await store.write({ name: '部署约定', abstract: '生产部署走 127.0.0.1 仅本地绑定', body: '细节略', type: 'fact' });
    const hits = store.search('本地绑定');
    expect(hits.some((h) => h.name === '部署约定')).toBe(true);
    const short = store.search('部署');
    expect(short.some((h) => h.name === '部署约定')).toBe(true);
  });

  it('lists entries and groups by scope', async () => {
    await store.write({ name: 'proj-note', abstract: '项目级记忆', body: 'x', scope: 'project-agora' });
    const groups = store.groups();
    expect(groups.some((g) => g.scope === 'global' && g.group === 'decisions')).toBe(true);
    expect(groups.some((g) => g.scope === 'project-agora')).toBe(true);
    const scoped = store.list('project-agora');
    expect(scoped.length).toBe(1);
    expect(scoped[0]!.name).toBe('proj-note');
  });

  it('maintains MEMORY.md root index automatically', async () => {
    const root = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(root).toContain('# MEMORY');
    expect(root).toContain('agora-design.md');
    expect(root).toContain('Agora 采用 Markdown 真相');
  });

  it('removes entries and their FTS rows', async () => {
    await store.write({ name: 'to-delete', abstract: '马上删除', body: 'x' });
    const ok = await store.remove('global/notes/to-delete.md');
    expect(ok).toBe(true);
    expect(store.search('马上删除').length).toBe(0);
    expect(existsSync(join(dir, 'global/notes/to-delete.md'))).toBe(false);
  });

  it('rebuilds the index from disk with zero loss (index is a cache)', async () => {
    // Simulate a file written out-of-band + a wiped index.
    mkdirSync(join(dir, 'global/facts'), { recursive: true });
    writeFileSync(
      join(dir, 'global/facts/oob.md'),
      '---\nname: oob\nabstract: 带外写入的文件\ntype: fact\n---\n\n内容\n',
    );
    db.prepare('DELETE FROM memory_entries').run();
    db.prepare('DELETE FROM memory_fts').run();
    expect(store.list().length).toBeGreaterThan(0);

    const { indexed } = await store.reindex();
    expect(indexed).toBeGreaterThan(0);
    const hits = store.search('带外写入');
    expect(hits.some((h) => h.name === 'oob')).toBe(true);
    // Previously indexed entries are back too.
    expect(store.search('本地绑定').length).toBeGreaterThan(0);
  });
});

it('sees external edits automatically and rejects stale conditional writes', async () => {
  writeFileSync(join(dir, 'global/facts/oob.md'), '---\nname: oob\nabstract: changed externally\n---\nnew text');
  expect(store.search('changed externally')).toHaveLength(1);
  await expect(store.write({ name: 'agora-design', group: 'decisions', abstract: 'stale', body: 'bad', expectedUpdatedAt: 'outdated' })).rejects.toThrow('重新读取');
});

it('uses body revision for conflicts even if frontmatter timestamp is unchanged', async () => {
  const created = await store.write({name:'revision', abstract:'revision', body:'initial'});
  const first = (await store.read(created.path))!;
  const abs = join(dir, created.path);
  writeFileSync(abs, readFileSync(abs,'utf8').replace('initial', 'external'));
  await expect(store.write({name:'revision',abstract:'revision',body:'stale',expectedRevision:first.revision!})).rejects.toThrow('重新读取');
  const current = (await store.read(created.path))!;
  await store.write({name:'revision',abstract:'revision',body:'merged',expectedRevision:current.revision!});
  expect((await store.read(created.path))!.body).toContain('merged');
  expect(existsSync(join(dir,'.history'))).toBe(true);
});
