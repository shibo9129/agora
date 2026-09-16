import { useCallback, useEffect, useState } from 'react';

/** In-app update via tauri-plugin-updater (no-op in browser/dev). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes?: string }
  | { status: 'downloading'; percent: number }
  | { status: 'installing' }
  | { status: 'done' }
  | { status: 'uptodate'; version: string }
  | { status: 'error'; message: string };

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function useAppUpdater() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  const check = useCallback(async (interactive = true): Promise<void> => {
    if (!isTauri()) {
      if (interactive) setState({ status: 'uptodate', version: 'dev' });
      return;
    }
    setState({ status: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        setState({ status: 'available', version: update.version, ...(update.body !== undefined ? { notes: update.body } : {}) });
      } else {
        setState({ status: 'uptodate', version: '' });
      }
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (!isTauri()) return;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setState({ status: 'uptodate', version: '' });
        return;
      }
      let downloaded = 0;
      let total = 0;
      setState({ status: 'downloading', percent: 0 });
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const percent = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 50;
          setState({ status: 'downloading', percent });
        } else if (event.event === 'Finished') {
          setState({ status: 'installing' });
        }
      });
      setState({ status: 'done' });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // Silent auto-check once on startup (desktop only).
  useEffect(() => {
    if (isTauri()) {
      const t = setTimeout(() => void check(false), 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [check]);

  return { state, check, install, isTauri: isTauri() };
}
