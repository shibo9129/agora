import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { builtinAdapters, detectAgents, type AdapterEnv } from '../index.js';

let home: string;
let bin: string;
let env: AdapterEnv;

function touchBin(name: string): void {
  const p = join(bin, name);
  writeFileSync(p, '#!/bin/sh\n');
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agora-adapters-home-'));
  bin = mkdtempSync(join(tmpdir(), 'agora-adapters-bin-'));
  env = { home, env: { PATH: bin } };
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe('new mainstream agent adapters', () => {
  it('detects grok via ~/.grok + bundled bin/grok (not on PATH)', async () => {
    mkdirSync(join(home, '.grok', 'bin'), { recursive: true });
    writeFileSync(join(home, '.grok', 'bin', 'grok'), '#!/bin/sh\n');
    writeFileSync(join(home, '.grok', 'config.toml'), '');
    const found = (await detectAgents(env)).find((a) => a.id === 'grok');
    expect(found?.installed).toBe(true);
    expect(found?.presence).toBe('installed');
    expect(found?.detail).toBe('config.toml found');
  });

  it('detects qwen-code via ~/.qwen + qwen on PATH', async () => {
    mkdirSync(join(home, '.qwen'), { recursive: true });
    writeFileSync(join(home, '.qwen', 'settings.json'), '{}');
    touchBin('qwen');
    const found = (await detectAgents(env)).find((a) => a.id === 'qwen-code');
    expect(found?.installed).toBe(true);
    expect(found?.detail).toBe('settings.json found');
  });

  it('detects kimi-code via ~/.kimi-code/bin/kimi', async () => {
    mkdirSync(join(home, '.kimi-code', 'bin'), { recursive: true });
    writeFileSync(join(home, '.kimi-code', 'bin', 'kimi'), '#!/bin/sh\n');
    const found = (await detectAgents(env)).find((a) => a.id === 'kimi-code');
    expect(found?.installed).toBe(true);
  });

  it('detects aider via ~/.aider.conf.yml file (no config dir)', async () => {
    writeFileSync(join(home, '.aider.conf.yml'), '');
    touchBin('aider');
    const found = (await detectAgents(env)).find((a) => a.id === 'aider');
    expect(found?.installed).toBe(true);
  });

  it('marks config leftovers as residual when the binary is gone', async () => {
    mkdirSync(join(home, '.factory'), { recursive: true });
    const found = (await detectAgents(env)).find((a) => a.id === 'droid');
    expect(found?.installed).toBe(false);
    expect(found?.presence).toBe('residual');
  });

  it('reports absent for agents with neither config nor binary', async () => {
    const found = (await detectAgents(env)).find((a) => a.id === 'amp');
    expect(found?.installed).toBe(false);
    expect(found?.presence).toBe('absent');
  });

  it('every adapter has a unique id', () => {
    const ids = builtinAdapters.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
