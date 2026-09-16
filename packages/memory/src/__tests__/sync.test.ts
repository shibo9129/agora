import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters } from '@agora/adapters';
import { MemoryStore, syncAgentMemories } from '../index.js';

let root: string;
let store: MemoryStore;
let env: { home: string; env: NodeJS.ProcessEnv };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agora-memsync-'));
  env = { home: root, env: {} };
  store = new MemoryStore(new Database(':memory:'), join(root, 'hub-memory'));

  // codex memories
  mkdirSync(join(root, '.codex/memories/rollout_summaries'), { recursive: true });
  writeFileSync(
    join(root, '.codex/memories/rollout_summaries/2026-09-10.md'),
    '# 部署流水线迁移完成\n\n完成了从老流水线到 N12 的迁移，回滚点已记录。',
  );
  writeFileSync(
    join(root, '.codex/memories/raw_memories.md'),
    '---\nname: 偏好事实\nabstract: Stan 偏好先给结论再给依据\n---\n\n沟通风格偏好。',
  );
  writeFileSync(join(root, '.codex/memories/MEMORY.md'), '# index (should be skipped)');
  writeFileSync(join(root, '.codex/memories/USER.md.bak'), 'backup, skipped');
  // hermes memories
  mkdirSync(join(root, '.hermes/memories'), { recursive: true });
  writeFileSync(join(root, '.hermes/memories/USER.md'), '# 用户画像\n\nStanshek，证券测试工程师，喜欢结构化。');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('syncAgentMemories', () => {
  it('syncs markdown memories from agent dirs into synced/<agent>/', async () => {
    const report = await syncAgentMemories(store, env, builtinAdapters);
    const codex = report.agents.find((a) => a.agent === 'codex')!;
    expect(codex.synced).toBe(2); // MEMORY.md and .bak skipped
    const hermes = report.agents.find((a) => a.agent === 'hermes')!;
    expect(hermes.synced).toBe(1);

    const entries = store.list('synced', 'codex');
    expect(entries.length).toBe(2);
    const titles = entries.map((e) => e.name).join('|');
    expect(titles).toContain('部署流水线迁移完成');
    expect(titles).toContain('偏好事实');
  });

  it('extracts heading/first-line as title and abstract', async () => {
    const entries = store.list('synced', 'codex');
    const rollout = entries.find((e) => e.name.includes('部署流水线迁移完成'))!;
    // abstract comes from the first content paragraph (heading is the title)
    expect(rollout.abstract).toContain('完成了从老流水线到 N12 的迁移');
    const hermes = store.list('synced', 'hermes')[0]!;
    expect(hermes.abstract).toContain('Stanshek');
  });

  it('uses frontmatter abstract when present', async () => {
    const entries = store.list('synced', 'codex');
    const pref = entries.find((e) => e.name.includes('偏好事实'))!;
    expect(pref.abstract).toBe('Stan 偏好先给结论再给依据');
  });

  it('is idempotent (same sources overwrite, no duplicates)', async () => {
    await syncAgentMemories(store, env, builtinAdapters);
    const first = store.list('synced').length;
    await syncAgentMemories(store, env, builtinAdapters);
    expect(store.list('synced').length).toBe(first);
  });

  it('records source path and agent attribution in the body', async () => {
    const entries = store.list('synced', 'codex');
    const doc = await store.read(entries[0]!.path);
    expect(doc!.body).toContain('.codex/memories/');
    expect(entries[0]!.by).toBe('codex');
  });
});
