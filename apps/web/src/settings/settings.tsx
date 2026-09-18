import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** App-wide user settings. Canonical copy lives in ~/.agora/ui-settings.json. */

export type ThemeMode = 'auto' | 'dark' | 'light';
export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'HKD';

export interface AppSettings {
  themeMode: ThemeMode;
  darkSkin: string;
  lightSkin: string;
  currency: CurrencyCode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'auto',
  darkSkin: 'aurora',
  lightSkin: 'paper',
  currency: 'USD',
};

export const STATIC_FALLBACK_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  CNY: 7.2,
  EUR: 0.92,
  HKD: 7.8,
};

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  HKD: 'HK$',
};

const CURRENCIES = new Set<CurrencyCode>(['USD', 'CNY', 'EUR', 'HKD']);
const THEME_MODES = new Set<ThemeMode>(['auto', 'dark', 'light']);

/** Live rates from the hub server (frankfurter via /api/rates, cached 12h). */
export interface RatesInfo {
  rates: { CNY: number; EUR: number; HKD: number };
  fetchedAt: string;
  source: 'frankfurter' | 'cache' | 'fallback' | 'loading';
}

export async function fetchLiveRates(): Promise<RatesInfo | null> {
  try {
    const res = await fetch('/api/rates');
    if (!res.ok) return null;
    const body = (await res.json()) as { rates: { CNY: number; EUR: number; HKD: number }; fetchedAt: string; source: RatesInfo['source'] };
    return { rates: body.rates, fetchedAt: body.fetchedAt, source: body.source };
  } catch {
    return null;
  }
}

const STORAGE_KEY = 'agora-settings';
const RATES_REFRESH_MS = 12 * 60 * 60 * 1000;

function parseSettings(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  if (typeof o['themeMode'] === 'string' && THEME_MODES.has(o['themeMode'] as ThemeMode)) {
    out.themeMode = o['themeMode'] as ThemeMode;
  }
  if (typeof o['darkSkin'] === 'string' && o['darkSkin']) out.darkSkin = o['darkSkin'];
  if (typeof o['lightSkin'] === 'string' && o['lightSkin']) out.lightSkin = o['lightSkin'];
  if (typeof o['currency'] === 'string' && CURRENCIES.has(o['currency'] as CurrencyCode)) {
    out.currency = o['currency'] as CurrencyCode;
  }
  return out;
}

function loadLocalSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...parseSettings(JSON.parse(raw)) };
  } catch {
    // corrupted storage → defaults
  }
  return { ...DEFAULT_SETTINGS };
}

async function fetchRemoteSettings(): Promise<{ settings: AppSettings; persisted: boolean } | null> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return null;
    const body = (await res.json()) as AppSettings & { persisted?: boolean };
    return { settings: { ...DEFAULT_SETTINGS, ...parseSettings(body) }, persisted: body.persisted === true };
  } catch {
    return null;
  }
}

async function persistRemoteSettings(settings: AppSettings): Promise<void> {
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Agora-Request': '1' },
    body: JSON.stringify({
      themeMode: settings.themeMode,
      darkSkin: settings.darkSkin,
      lightSkin: settings.lightSkin,
      currency: settings.currency,
    }),
  });
}

interface SettingsContextValue {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  /** Format a USD cost into the selected currency. */
  formatMoney: (usd: number) => string;
  /** Resolved theme after applying 'auto' (system preference). */
  resolvedTheme: 'dark' | 'light';
  /** Live rates state (server-provided when available). */
  liveRates: RatesInfo | null;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadLocalSettings);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [liveRates, setLiveRates] = useState<RatesInfo | null>(null);

  // Deep-link a skin for shareable URLs / screenshots: ?theme=light:paper
  const urlTheme = useMemo(() => {
    const m = new URLSearchParams(window.location.search).get('theme');
    return m && /^(dark|light):[a-z]+$/.test(m) ? (m as `${'dark' | 'light'}:${string}`) : null;
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Hydrate from ~/.agora/ui-settings.json (survives updates). If the server
  // has never saved, migrate whatever localStorage still has.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remote = await fetchRemoteSettings();
      if (cancelled || !remote) return;
      if (remote.persisted) {
        setSettings(remote.settings);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(remote.settings));
        } catch {
          // ignore quota
        }
        return;
      }
      const local = loadLocalSettings();
      const hasLocal = JSON.stringify(local) !== JSON.stringify(DEFAULT_SETTINGS);
      if (hasLocal) {
        try {
          await persistRemoteSettings(local);
        } catch {
          // keep using local until the next launch
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull live rates once at startup (and refresh every 12h while running).
  useEffect(() => {
    let mounted = true;
    const pull = async () => {
      const info = await fetchLiveRates();
      if (mounted && info) setLiveRates(info);
    };
    void pull();
    const timer = setInterval(pull, RATES_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota
      }
      void persistRemoteSettings(next).catch(() => null);
      return next;
    });
  }, []);

  const resolvedTheme: 'dark' | 'light' =
    settings.themeMode === 'auto' ? (systemDark ? 'dark' : 'light') : settings.themeMode;

  // Apply theme to <html data-theme="dark:aurora" style="color-scheme: dark">
  useEffect(() => {
    const skin = urlTheme
      ? urlTheme.split(':')[1]
      : resolvedTheme === 'dark'
        ? settings.darkSkin
        : settings.lightSkin;
    const mode = urlTheme ? urlTheme.split(':')[0] : resolvedTheme;
    document.documentElement.dataset['theme'] = `${mode}:${skin}`;
    document.documentElement.style.colorScheme = mode!;
  }, [resolvedTheme, settings.darkSkin, settings.lightSkin, urlTheme]);

  const formatMoney = useCallback(
    (usd: number): string => {
      const live = settings.currency === 'USD' ? 1 : liveRates?.rates[settings.currency];
      const rate = live ?? STATIC_FALLBACK_RATES[settings.currency];
      const symbol = CURRENCY_SYMBOLS[settings.currency];
      const converted = usd * rate;
      if (converted >= 1000) return `${symbol}${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      if (converted >= 100) return `${symbol}${converted.toFixed(0)}`;
      if (converted >= 1) return `${symbol}${converted.toFixed(2)}`;
      return `${symbol}${converted.toFixed(4)}`;
    },
    [settings.currency, liveRates],
  );

  const value = useMemo(
    () => ({ settings, update, formatMoney, resolvedTheme, liveRates }),
    [settings, update, formatMoney, resolvedTheme, liveRates],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
