import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listUndoRecords, migrateKnowledge, createKb } from '../registry.js';
import { scanKb } from '../indexer.js';
import { executeMoves, proposeOrganization, undoMoves } from '../organize.js';
import type { KnowledgeBase } from '../types.js';

let dir: string;
let db: Database.Database;
let kb: KnowledgeBase;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agora-kb-org-'));
  // A mixed directory worth organizing: 2 docs + 2 images + 1 unknown
  writeFileSync(join(dir, 'a.txt'), 'a');
  writeFileSync(join(dir, 'b.pdf'), 'b');
  writeFileSync(join(dir, 'c.png'), 'c');
  writeFileSync(join(dir, 'd.jpg'), 'd');
  writeFileSync(join(dir, 'note.xyz'), 'x');

  db = new Database(':memory:');
  migrateKnowledge(db);
  kb = createKb(db, 'org', dir);
  await scanKb(db, kb.id, dir);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('organize', () => {
  it('proposes category buckets for a mixed directory', () => {
    const plan = proposeOrganization(db, kb.id, '');
    expect(plan.moves.length).toBe(4);
    expect(plan.moves.find((m) => m.from === 'a.txt')!.to).toBe('docs/a.txt');
    expect(plan.moves.find((m) => m.from === 'c.png')!.to).toBe('images/c.png');
    expect(plan.skipped.some((s) => s.path === 'note.xyz')).toBe(true);
  });

  it('executes moves, logs undo, and reverses them', async () => {
    const plan = proposeOrganization(db, kb.id, '');
    const exec = await executeMoves(db, kb.id, dir, plan.moves);
    expect(exec.failed.length).toBe(0);
    expect(exec.moved.length).toBe(4);
    expect(existsSync(join(dir, 'docs/a.txt'))).toBe(true);
    expect(existsSync(join(dir, 'images/d.jpg'))).toBe(true);
    expect(exec.undoId).not.toBeNull();

    const undos = listUndoRecords(db, kb.id);
    expect(undos.length).toBe(1);
    expect(undos[0]!.moves.length).toBe(4);

    const undone = await undoMoves(db, dir, undos[0]!.id, undos[0]!.moves);
    expect(undone.failed.length).toBe(0);
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    expect(existsSync(join(dir, 'docs/a.txt'))).toBe(false);
  });

  it('refuses path escapes', async () => {
    const exec = await executeMoves(db, kb.id, dir, [{ from: 'a.txt', to: '../escape.md', reason: 'x' }]);
    expect(exec.moved.length).toBe(0);
    expect(exec.failed.length).toBe(1);
  });

  it('never overwrites an existing target', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b-existing');
    // simulate: a.txt → docs/b.txt where docs/b.txt already exists
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/b.txt'), 'do-not-touch');
    const exec = await executeMoves(db, kb.id, dir, [{ from: 'b.txt', to: 'docs/b.txt', reason: 'x' }]);
    expect(exec.failed.length).toBe(1);
    expect(exec.moved.length).toBe(0);
  });
});

it('lists a below-threshold category in skipped instead of silently dropping it', async () => {
  // 2 docs + 2 images (organizable) + 1 lone zip (its own category, but below
  // MIN_CATEGORY_SIZE) — the zip must show up in `skipped`, not vanish
  // without explanation the way `noCategory` files never did.
  const d = mkdtempSync(join(tmpdir(), 'agora-kb-org2-'));
  writeFileSync(join(d, 'a.txt'), 'a');
  writeFileSync(join(d, 'b.pdf'), 'b');
  writeFileSync(join(d, 'c.png'), 'c');
  writeFileSync(join(d, 'd.jpg'), 'd');
  writeFileSync(join(d, 'e.zip'), 'e');
  const db2 = new Database(':memory:');
  migrateKnowledge(db2);
  const kb2 = createKb(db2, 'org2', d);
  await scanKb(db2, kb2.id, d);
  const plan = proposeOrganization(db2, kb2.id, '');
  expect(plan.moves.some((m) => m.from === 'e.zip')).toBe(false);
  expect(plan.skipped.some((s) => s.path === 'e.zip')).toBe(true);
  db2.close();
  rmSync(d, { recursive: true, force: true });
});

it('protects wiki entrypoints and rejects symlink ancestors', async () => {
  const { symlinkSync, mkdirSync } = await import('node:fs');
  writeFileSync(join(dir, 'AGENTS.md'), 'keep');
  await scanKb(db, kb.id, dir);
  expect(proposeOrganization(db, kb.id).moves.some(m => m.from === 'AGENTS.md')).toBe(false);
  expect((await executeMoves(db, kb.id, dir, [{ from: 'AGENTS.md', to: 'docs/AGENTS.md', reason: '' }])).moved).toHaveLength(0);
  mkdirSync(join(dir, 'external'), { recursive: true });
  symlinkSync(join(dir, 'external'), join(dir, 'escape'));
  writeFileSync(join(dir, 'probe.txt'), 'keep');
  expect((await executeMoves(db, kb.id, dir, [{ from: 'probe.txt', to: 'escape/probe.txt', reason: '' }])).moved).toHaveLength(0);
  expect(existsSync(join(dir, 'probe.txt'))).toBe(true);
});
