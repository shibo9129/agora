import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_SETTINGS,
  parseUiSettings,
  readUiSettings,
  writeUiSettings,
} from '../settings.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agora-ui-settings-'));
  dirs.push(dir);
  return dir;
}

describe('ui settings persistence', () => {
  it('returns defaults when no file exists', () => {
    const home = tmpHome();
    expect(readUiSettings(home)).toEqual({ settings: DEFAULT_UI_SETTINGS, persisted: false });
  });

  it('round-trips currency and theme across a simulated app update', () => {
    const home = tmpHome();
    writeUiSettings({ ...DEFAULT_UI_SETTINGS, currency: 'CNY', themeMode: 'dark', darkSkin: 'violet' }, home);
    const disk = JSON.parse(readFileSync(join(home, 'ui-settings.json'), 'utf-8')) as { currency: string };
    expect(disk.currency).toBe('CNY');
    expect(readUiSettings(home)).toEqual({
      settings: { ...DEFAULT_UI_SETTINGS, currency: 'CNY', themeMode: 'dark', darkSkin: 'violet' },
      persisted: true,
    });
  });

  it('ignores unknown currency and leftover manual rates', () => {
    expect(parseUiSettings({ currency: 'JPY', rates: { CNY: 9 }, themeMode: 'dark' })).toEqual({ themeMode: 'dark' });
    expect(parseUiSettings({ currency: 'HKD' })).toEqual({ currency: 'HKD' });
  });
});
