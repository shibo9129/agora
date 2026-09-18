import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readHubConfig, writeHubConfig } from '../memory.js';

const dirs: string[] = [];
const previousHome = process.env['AGORA_HOME'];

afterEach(() => {
  if (previousHome === undefined) delete process.env['AGORA_HOME'];
  else process.env['AGORA_HOME'] = previousHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('memory hub config persistence', () => {
  it('keeps the custom memory root and autoSync flag across restarts', () => {
    const home = mkdtempSync(join(tmpdir(), 'agora-mem-cfg-'));
    dirs.push(home);
    process.env['AGORA_HOME'] = home;
    const root = join(home, 'custom-memory');
    mkdirSync(root);

    writeHubConfig({ autoSync: true, memoryRoot: root, syncIntervalMinutes: 30, autoEnroll: true });

    const disk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8')) as {
      memoryRoot: string;
      autoSync: boolean;
      syncIntervalMinutes: number;
    };
    expect(disk.memoryRoot).toBe(root);
    expect(disk.autoSync).toBe(true);
    expect(disk.syncIntervalMinutes).toBe(30);

    expect(readHubConfig()).toEqual({
      autoSync: true,
      memoryRoot: root,
      syncIntervalMinutes: 30,
      autoEnroll: true,
    });
  });
});
