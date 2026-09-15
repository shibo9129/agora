import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateKnowledge, createKb, kbStats } from '../registry.js';
import { scanKb } from '../indexer.js';
import { queryTreemap, searchKb } from '../query.js';
import type { KnowledgeBase } from '../types.js';

let dir: string;
let db: Database.Database;
let kb: KnowledgeBase;

function tree(root: string): void {
  mkdirSync(join(root, 'docs/guide'), { recursive: true });
  mkdirSync(join(root, 'raw/2026'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  writeFileSync(join(root, 'index.md'), '# 索引\n'.repeat(10));
  writeFileSync(join(root, 'docs/guide/getting-started.md'), '入门指南内容\n'.repeat(20));
  writeFileSync(join(root, 'docs/api.md'), 'API 文档\n'.repeat(5));
  writeFileSync(join(root, 'raw/2026/log.jsonl'), '{"a":1}\n'.repeat(50));
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'x'.repeat(9999));
  writeFileSync(join(root, '.gitignore'), 'raw/2026/secret.txt\n');
  writeFileSync(join(root, 'raw/2026/secret.txt'), 'should be ignored');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agora-kb-idx-'));
  tree(dir);
  db = new Database(':memory:');
  migrateKnowledge(db);
  kb = createKb(db, 'fixture', dir);
  await scanKb(db, kb.id, dir);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexer', () => {
  it('indexes files and dirs with aggregated sizes', () => {
    const stats = kbStats(db, kb.id);
    // 5 real files: index.md, .gitignore, getting-started.md, api.md, log.jsonl
    // (node_modules and the gitignored secret.txt are excluded)
    expect(stats.fileCount).toBe(5);
    expect(stats.dirCount).toBeGreaterThanOrEqual(4); // docs, docs/guide, raw, raw/2026
    const root = db.prepare(`SELECT size FROM kb_entries WHERE kb_id = ? AND path = ''`).get(kb.id) as { size: number };
    const docs = db.prepare(`SELECT size FROM kb_entries WHERE kb_id = ? AND path = 'docs'`).get(kb.id) as { size: number };
    const file = db.prepare(`SELECT size FROM kb_entries WHERE kb_id = ? AND path = 'docs/api.md'`).get(kb.id) as {
      size: number;
    };
    expect(root.size).toBeGreaterThan(docs.size);
    expect(docs.size).toBeGreaterThan(file.size);
  });

  it('excludes node_modules and gitignored files', () => {
    const nm = db.prepare(`SELECT COUNT(*) n FROM kb_entries WHERE kb_id = ? AND path LIKE 'node_modules%'`).get(
      kb.id,
    ) as { n: number };
    expect(nm.n).toBe(0);
    const secret = db.prepare(`SELECT COUNT(*) n FROM kb_entries WHERE kb_id = ? AND path LIKE '%secret%'`).get(
      kb.id,
    ) as { n: number };
    expect(secret.n).toBe(0);
  });

  it('incremental rescan: detects modify and delete', async () => {
    writeFileSync(join(dir, 'docs/api.md'), 'API 文档 v2 更长的内容\n'.repeat(10));
    unlinkSync(join(dir, 'raw/2026/log.jsonl'));
    const res = await scanKb(db, kb.id, dir);
    expect(res.updated).toBeGreaterThanOrEqual(1);
    expect(res.removed).toBe(1);
    const stats = kbStats(db, kb.id);
    expect(stats.fileCount).toBe(4);
  });
});

describe('treemap query', () => {
  it('builds a nested treemap with counts', () => {
    const tm = queryTreemap(db, kb.id, '', 4)!;
    expect(tm.path).toBe('');
    expect(tm.size).toBeGreaterThan(0);
    expect(tm.children!.length).toBeGreaterThanOrEqual(3); // index.md, docs, raw
    const docs = tm.children!.find((c) => c.name === 'docs')!;
    expect(docs.fileCount).toBe(2);
    expect(docs.children!.some((c) => c.name === 'guide')).toBe(true);
  });

  it('supports drilling into a prefix', () => {
    const tm = queryTreemap(db, kb.id, 'docs', 2)!;
    expect(tm.name).toBe('docs');
    expect(tm.children!.find((c) => c.name === 'guide')!.fileCount).toBe(1);
  });
});

describe('search', () => {
  it('finds by trigram FTS for >=3 char queries', () => {
    const hits = searchKb(db, kb.id, 'getting');
    expect(hits.some((h) => h.path === 'docs/guide/getting-started.md')).toBe(true);
  });

  it('finds CJK names', () => {
    writeFileSync(join(dir, 'docs/知识图谱设计.md'), '内容');
    return scanKb(db, kb.id, dir).then(() => {
      const hits = searchKb(db, kb.id, '知识图谱');
      expect(hits.some((h) => h.name === '知识图谱设计.md')).toBe(true);
    });
  });

  it('falls back to LIKE for short queries', () => {
    const hits = searchKb(db, kb.id, 'ap');
    expect(hits.some((h) => h.name === 'api.md')).toBe(true);
  });
});
