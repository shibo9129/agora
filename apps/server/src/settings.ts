/**
 * UI settings persisted under AGORA_HOME so they survive app updates and
 * the desktop webview's random localhost origin (localStorage is per-port).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Hono } from 'hono';

export type ThemeMode = 'auto' | 'dark' | 'light';
export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'HKD';

export interface UiSettings {
  themeMode: ThemeMode;
  darkSkin: string;
  lightSkin: string;
  currency: CurrencyCode;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  themeMode: 'auto',
  darkSkin: 'aurora',
  lightSkin: 'paper',
  currency: 'USD',
};

const THEME_MODES = new Set<ThemeMode>(['auto', 'dark', 'light']);
const CURRENCIES = new Set<CurrencyCode>(['USD', 'CNY', 'EUR', 'HKD']);

function agoraHome(): string {
  return process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
}

export function uiSettingsPath(home = agoraHome()): string {
  return join(home, 'ui-settings.json');
}

export function parseUiSettings(raw: unknown): Partial<UiSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<UiSettings> = {};
  if (typeof o['themeMode'] === 'string' && THEME_MODES.has(o['themeMode'] as ThemeMode)) {
    out.themeMode = o['themeMode'] as ThemeMode;
  }
  if (typeof o['darkSkin'] === 'string' && o['darkSkin'].length > 0 && o['darkSkin'].length < 32) {
    out.darkSkin = o['darkSkin'];
  }
  if (typeof o['lightSkin'] === 'string' && o['lightSkin'].length > 0 && o['lightSkin'].length < 32) {
    out.lightSkin = o['lightSkin'];
  }
  if (typeof o['currency'] === 'string' && CURRENCIES.has(o['currency'] as CurrencyCode)) {
    out.currency = o['currency'] as CurrencyCode;
  }
  return out;
}

export function readUiSettings(home = agoraHome()): { settings: UiSettings; persisted: boolean } {
  const path = uiSettingsPath(home);
  if (!existsSync(path)) return { settings: { ...DEFAULT_UI_SETTINGS }, persisted: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return { settings: { ...DEFAULT_UI_SETTINGS, ...parseUiSettings(parsed) }, persisted: true };
  } catch {
    return { settings: { ...DEFAULT_UI_SETTINGS }, persisted: false };
  }
}

export function writeUiSettings(settings: UiSettings, home = agoraHome()): void {
  const path = uiSettingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

export function settingsRoutes(): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const { settings, persisted } = readUiSettings();
    return c.json({ ...settings, persisted });
  });
  app.put('/', async (c) => {
    const body = parseUiSettings(await c.req.json().catch(() => ({})));
    const current = readUiSettings().settings;
    const next: UiSettings = { ...current, ...body };
    writeUiSettings(next);
    return c.json({ ...next, persisted: true });
  });
  return app;
}
