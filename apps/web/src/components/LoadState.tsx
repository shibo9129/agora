import { useCallback, useState, type ReactNode } from 'react';

/**
 * Page load state.
 *
 * Every page here fetches on mount and re-fetches on hub events. Without a
 * phase the first render is indistinguishable from an empty result, so the UI
 * asserts things like "未检测到已安装且支持 skills 的 Agent" for the second or
 * two the scan takes — and, if the fetch rejects, keeps asserting it forever.
 * `usePageLoad` separates the three real states; re-fetches keep the current
 * content on screen (no skeleton flash) and only surface failures.
 */
export function usePageLoad(load: () => Promise<unknown>) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const run = useCallback(async () => {
    try {
      await load();
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  return {
    /** First fetch still in flight — render a skeleton, not an empty state. */
    pending: !loaded && error === null,
    /** Message of the most recent failure, or null. */
    error,
    /** Content has been loaded at least once (a later refresh may have failed). */
    loaded,
    run,
  };
}

/** Placeholder bars matching the density of the content they stand in for. */
export function Skeleton({ rows = 5, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-3.5" style={{ width: `${88 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}

// A dead or restarting sidecar surfaces as the browser's own opaque network
// error ("Load failed" / "Failed to fetch"), which tells the user nothing.
const NETWORK_ERROR = /^(load failed|failed to fetch|networkerror.*)$/i;

/** A failed fetch, with the reason and a way out. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const offline = NETWORK_ERROR.test(message.trim());
  return (
    <div className="rounded-2xl border border-[var(--color-edge)] bg-[var(--color-panel)] px-5 py-8 text-center">
      <div className="text-sm font-medium">加载失败</div>
      <div className="mt-1.5 text-xs text-[var(--color-ink-dim)] break-all">
        {offline ? `连接不上 Agora 服务（可能正在启动或已退出）· ${message}` : message}
      </div>
      <button onClick={onRetry} className="btn-ghost mt-4 text-xs">
        重试
      </button>
    </div>
  );
}

/**
 * Renders the skeleton while the first fetch runs, the error (with retry) when
 * it failed and nothing has ever loaded, and the page otherwise — a stale view
 * plus a toast beats blanking the page when a background refresh fails.
 */
export function LoadGate({
  state,
  skeleton,
  children,
}: {
  state: ReturnType<typeof usePageLoad>;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  if (state.error !== null && !state.loaded) return <LoadError message={state.error} onRetry={() => void state.run()} />;
  if (state.pending) return <>{skeleton ?? <Skeleton />}</>;
  return <>{children}</>;
}
