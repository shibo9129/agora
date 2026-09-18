import { useState } from 'react';
import { pickDirectory } from '../desktop';

export function DirectoryPicker({
  value,
  onChange,
  title = '选择目录',
  placeholder = '尚未选择目录',
}: {
  value: string;
  onChange: (path: string) => void;
  title?: string;
  placeholder?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await pickDirectory(title);
      if (path) onChange(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-stretch gap-2">
        <div className="input-field flex min-w-0 flex-1 items-center font-mono text-xs">
          <span className={`truncate ${value ? '' : 'text-[var(--color-ink-faint)]'}`}>{value || placeholder}</span>
        </div>
        <button type="button" onClick={() => void pick()} disabled={busy} className="btn-ghost shrink-0">
          {busy ? '选择中…' : '选择目录…'}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}
