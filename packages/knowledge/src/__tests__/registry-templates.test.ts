import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateKnowledge, createKb, listKbs, deleteKb } from '../registry.js';
import { scanKb } from '../indexer.js';
import { scaffoldTemplate } from '../index.js';
import { builtinTemplates, getTemplate } from '../templates.js';

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-kb-test-'));
  db = new Database(':memory:');
  migrateKnowledge(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('templates', () => {
  it('exposes two builtin templates', () => {
    expect(builtinTemplates.map((t) => t.id)).toEqual(['general-wiki', 'layered-wiki']);
  });

  it('scaffolds layered-wiki with dirs and seed files', async () => {
    const root = join(dir, 'my-wiki');
    mkdirSync(root);
    await scaffoldTemplate(root, getTemplate('layered-wiki')!);
    for (const d of ['00 Schema', '01 Raw', '02 Wiki', '99_Archive']) {
      expect(existsSync(join(root, d))).toBe(true);
    }
    expect(readFileSync(join(root, 'WIKI_ONBOARDING.md'), 'utf-8')).toContain('四层协议');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain('AGENTS.md');
  });

  it('does not overwrite existing seed files', async () => {
    const root = join(dir, 'my-wiki');
    await expect(scaffoldTemplate(root, getTemplate('layered-wiki')!)).rejects.toThrow();
  });
});

describe('registry', () => {
  it('creates, lists with stats, and deletes kbs', () => {
    const kb = createKb(db, '测试库', join(dir, 'my-wiki'), 'layered-wiki');
    expect(kb.id).toMatch(/^kb_/);
    const list = listKbs(db);
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe('测试库');
    deleteKb(db, kb.id);
    expect(listKbs(db).length).toBe(0);
  });

  it('rejects duplicate root paths', () => {
    createKb(db, 'A', join(dir, 'dup'));
    expect(() => createKb(db, 'B', join(dir, 'dup'))).toThrow();
  });
});
