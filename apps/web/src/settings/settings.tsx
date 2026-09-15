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
  rates: { USD: 1, CNY: 7.2, EUR: 0.92, HKD: 7.8 },
};

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  HKD: 'HK$',
};

const STORAGE_KEY = 'agora-settings';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        rates: { ...DEFAULT_SETTINGS.rates, ...(parsed.rates ?? {}) },
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
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
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
    const skin = resolvedTheme === 'dark' ? settings.darkSkin : settings.lightSkin;
    document.documentElement.dataset['theme'] = `${resolvedTheme}:${skin}`;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, settings.darkSkin, settings.lightSkin]);

  const formatMoney = useCallback(
    (usd: number): string => {
      const rate = settings.rates[settings.currency] ?? 1;
      const symbol = CURRENCY_SYMBOLS[settings.currency];
      const converted = usd * rate;
      if (converted >= 1000) return `${symbol}${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      if (converted >= 100) return `${symbol}${converted.toFixed(0)}`;
      if (converted >= 1) return `${symbol}${converted.toFixed(2)}`;
      return `${symbol}${converted.toFixed(4)}`;
    },
    [settings.currency, settings.rates],
  );

  const value = useMemo(
    () => ({ settings, update, formatMoney, resolvedTheme }),
    [settings, update, formatMoney, resolvedTheme],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
