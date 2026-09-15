import { useEffect, useRef, useState } from 'react';
import { useSettings, CURRENCY_SYMBOLS, type CurrencyCode } from './settings';

export const DARK_SKINS = [
  { id: 'aurora', name: '暗夜极光', accent: '#10b981' },
  { id: 'violet', name: '幽紫', accent: '#8b5cf6' },
  { id: 'ocean', name: '深海军蓝', accent: '#0ea5e9' },
] as const;

export const LIGHT_SKINS = [
  { id: 'paper', name: '纸白', accent: '#059669' },
  { id: 'sand', name: '暖米', accent: '#d97706' },
  { id: 'sky', name: '晴空', accent: '#0284c7' },
] as const;

function Swatch({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${active ? 'border-emerald-400' : 'border-transparent'}`}
      style={{ background: color, boxShadow: active ? `0 0 10px ${color}66` : undefined }}
    />
  );
}

export function SettingsPanel() {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost !rounded-full !p-2"
        title="设置"
        aria-label="设置"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="card dialog-panel absolute right-0 top-11 z-50 w-72 p-4">
          <div className="section-title mb-3">外观</div>
          <div className="mb-3 flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
            {(
              [
                ['auto', '跟随系统'],
                ['dark', '深色'],
                ['light', '浅色'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => update({ themeMode: mode })}
                className={settings.themeMode === mode ? 'nav-tab nav-tab-active flex-1 text-center' : 'nav-tab flex-1 text-center'}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mb-1 text-xs text-[var(--color-ink-dim)]">深色皮肤</div>
          <div className="mb-3 flex items-center gap-2">
            {DARK_SKINS.map((s) => (
              <Swatch key={s.id} color={s.accent} active={settings.darkSkin === s.id} onClick={() => update({ darkSkin: s.id })} />
            ))}
            <span className="text-xs text-[var(--color-ink-dim)]">{DARK_SKINS.find((s) => s.id === settings.darkSkin)?.name}</span>
          </div>

          <div className="mb-1 text-xs text-[var(--color-ink-dim)]">浅色皮肤</div>
          <div className="mb-4 flex items-center gap-2">
            {LIGHT_SKINS.map((s) => (
              <Swatch key={s.id} color={s.accent} active={settings.lightSkin === s.id} onClick={() => update({ lightSkin: s.id })} />
            ))}
            <span className="text-xs text-[var(--color-ink-dim)]">{LIGHT_SKINS.find((s) => s.id === settings.lightSkin)?.name}</span>
          </div>

          <div className="header-rule my-3" />
          <div className="section-title mb-3">币种</div>
          <div className="mb-3 flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
            {(Object.keys(CURRENCY_SYMBOLS) as CurrencyCode[]).map((cur) => (
              <button
                key={cur}
                onClick={() => update({ currency: cur })}
                className={settings.currency === cur ? 'nav-tab nav-tab-active flex-1 text-center' : 'nav-tab flex-1 text-center'}
              >
                {cur}
              </button>
            ))}
          </div>
          {settings.currency !== 'USD' && (
            <label className="flex items-center justify-between text-xs text-[var(--color-ink-dim)]">
              1 USD =
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.rates[settings.currency]}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v > 0) update({ rates: { ...settings.rates, [settings.currency]: v } });
                  }}
                  className="input-field w-20 !px-2 !py-1 text-right"
                />
                {settings.currency}
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
