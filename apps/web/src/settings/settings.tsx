import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** App-wide user settings (persisted to localStorage). */

export type ThemeMode = 'auto' | 'dark' | 'light';
export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'HKD';

export interface AppSettings {
  themeMode: ThemeMode;
  darkSkin: string;
  lightSkin: string;
  currency: CurrencyCode;
  /** Fiat per 1 USD (manually editable; offline defaults). */
  rates: Record<CurrencyCode, number>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'auto',
  darkSkin: 'aurora',
  lightSkin: 'paper',
  currency: 'USD',
  // Empty by default: only currencies the USER manually edited appear here.
  // Resolution order: manual > live (server) > static fallback.
  rates: {} as Record<CurrencyCode, number>,
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

/** Live rates from the hub server (frankfurter via /api/rates, cached 6h). */
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

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        rates: { ...(parsed.rates ?? {}) } as Record<CurrencyCode, number>,
      };
    }
  } catch {
    // corrupted storage → defaults
  }
  return DEFAULT_SETTINGS;
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
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
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

  // Pull live rates once at startup (and refresh every 6h while running).
  useEffect(() => {
    let mounted = true;
    const pull = async () => {
      const info = await fetchLiveRates();
      if (mounted && info) setLiveRates(info);
    };
    void pull();
    const timer = setInterval(pull, 6 * 60 * 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch, rates: { ...prev.rates, ...(patch.rates ?? {}) } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
      // Manual override wins; live rates beat static defaults.
      const manual = settings.rates[settings.currency];
      const live = settings.currency === 'USD' ? 1 : liveRates?.rates[settings.currency];
      const rate = manual ?? live ?? STATIC_FALLBACK_RATES[settings.currency];
      const symbol = CURRENCY_SYMBOLS[settings.currency];
      const converted = usd * rate;
      if (converted >= 1000) return `${symbol}${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      if (converted >= 100) return `${symbol}${converted.toFixed(0)}`;
      if (converted >= 1) return `${symbol}${converted.toFixed(2)}`;
      return `${symbol}${converted.toFixed(4)}`;
    },
    [settings.currency, settings.rates, liveRates],
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
