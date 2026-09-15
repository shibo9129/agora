import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatBytes,
  kbApi,
  type KbEntry,
  type KnowledgeBase,
  type OrganizeMove,
  type SearchHit,
  type TreemapNode,
} from './api';
import { Chart } from '../components/Chart';
import { getChartTheme, chartTooltipBase, useThemeTick } from '../components/chart-theme';

function toChartData(node: TreemapNode): Record<string, unknown> {
  return {
    itemStyle: { color: ['#164e3f', '#1e3a5f', '#3d3d4d', '#4c1d95', '#713f12', '#134e4a'][[...node.path].reduce((n,c) => n + c.charCodeAt(0), 0) % 6] },
    kind: node.kind,
    name: node.name,
    value: node.size,
    path: node.path,
    children: node.children?.map(toChartData),
  };
}

function OrganizeDialog({
  kb,
  subdir,
  onClose,
  onDone,
}: {
  kb: KnowledgeBase;
  subdir: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [moves, setMoves] = useState<OrganizeMove[] | null>(null);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    kbApi
      .propose(kb.id, subdir)
      .then((plan) => {
        setMoves(plan.moves);
        setSkipped(plan.skipped);
        setSelected(new Set(plan.moves.map((m) => m.from)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [kb.id, subdir]);

  const execute = async () => {
    if (!moves) return;
    setBusy(true);
    try {
      const chosen = moves.filter((m) => selected.has(m.from));
      const result = await kbApi.execute(kb.id, chosen);
      if (result.failed.length > 0) {
        setError(`部分失败：${result.failed.map((f) => `${f.from}（${f.error}）`).join('；')}`);
      }
      onDone(result.failed.length ? `已移动 ${result.moved.length} 项，${result.failed.length} 项失败` : `已移动 ${result.moved.length} 项，可在撤销记录中恢复`);
      if (result.failed.length === 0) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 font-medium">整理建议（{subdir || '根目录'}）</h3>
        {error && <div className="mb-3 rounded-lg bg-red-950/50 p-2 text-xs text-red-300">{error}</div>}
        {moves === null ? (
          <div className="py-8 text-center text-[var(--color-ink-dim)]">分析中…</div>
        ) : moves.length === 0 ? (
          <div className="py-8 text-center text-[var(--color-ink-dim)]">
            没有可整理的文件
            {skipped.length > 0 && <div className="mt-2 text-xs">{skipped[0]?.reason}</div>}
          </div>
        ) : (
          <>
            <div className="mb-3 space-y-1">
              {moves.map((m) => (
                <label key={m.from} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-panel-strong)]">
                  <input
                    type="checkbox"
                    checked={selected.has(m.from)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(m.from);
                      else next.delete(m.from);
                      setSelected(next);
                    }}
                  />
                  <span className="font-mono text-xs">{m.from}</span>
                  <span className="text-[var(--color-ink-dim)]">→</span>
                  <span className="font-mono text-xs text-emerald-400">{m.to}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn-ghost">
                取消
              </button>
              <button
                onClick={() => void execute()}
                disabled={busy || selected.size === 0}
                className="btn-primary"
              >
                {busy ? '执行中…' : `移动 ${selected.size} 个文件`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function KbDetail({ kb, onBack }: { kb: KnowledgeBase; onBack: () => void }) {
  const [currentPath, setCurrentPath] = useState('');
  const [undos, setUndos] = useState<{ id: number; ts: string; undoneAt?: string; moves: OrganizeMove[] }[]>([]);
  const [undoBusy, setUndoBusy] = useState(false);
  const [treemap, setTreemap] = useState<TreemapNode | null>(null);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [showOrganize, setShowOrganize] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [tm, en, history] = await Promise.all([kbApi.treemap(kb.id, currentPath, 4), kbApi.entries(kb.id, currentPath), kbApi.undos(kb.id)]);
    setUndos(history.records.filter(r => !r.undoneAt));
    setTreemap(tm);
    setEntries(en.entries);
  }, [kb.id, currentPath]);

  useEffect(() => {
    void load().catch(e => setMessage(String(e)));
  }, [load]);

  // Debounced name search
  useEffect(() => {
    if (query.trim().length === 0) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      kbApi.search(kb.id, query).then((r) => { if (!cancelled) setHits(r.hits); }).catch(e => { if (!cancelled) setMessage(String(e)); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [kb.id, query]);

  const themeTick = useThemeTick();

  const chartOption = useMemo(() => {
    if (!treemap) return {};
    const ct = getChartTheme();
    return {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (info: { name: string; value: number; data?: { path?: string } }) =>
          `${info.data?.path || info.name}<br/>${formatBytes(info.value)}`,
        ...chartTooltipBase(ct),
      },
      series: [
        {
          type: 'treemap' as const,
          data: treemap.children?.map(toChartData) ?? [toChartData(treemap)],
          roam: false,
          nodeClick: 'zoomToNode',
          width: '100%',
          height: '100%',
          breadcrumb: {
            show: true,
            top: 0,
            itemStyle: { color: 'rgba(128,128,140,0.15)', textStyle: { color: ct.legend } },
          },
          label: {
            color: ct.tooltipText,
            fontSize: 11,
            formatter: (p: { name: string; value: number }) => `${p.name}\n${formatBytes(p.value)}`,
          },
          itemStyle: { borderColor: 'rgba(0,0,0,0.3)', borderWidth: 2, gapWidth: 2 },
          levels: [
            { itemStyle: { borderWidth: 0, gapWidth: 3 } },
            { itemStyle: { gapWidth: 2 } },
            { color: ['#164e3f', '#1e3a5f', '#3d3d4d', '#4c1d95', '#713f12', '#134e4a'] },
            { colorSaturation: [0.28, 0.45] },
          ],
        },
      ],
    };
  }, [treemap, themeTick]);

  const breadcrumbs = useMemo(() => {
    const parts = currentPath === '' ? [] : currentPath.split('/');
    return [{ name: kb.name, path: '' }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join('/') }))];
  }, [currentPath, kb.name]);

  const openInFinder = async (path: string) => {
    try {
      await kbApi.open(kb.id, path);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <button onClick={onBack} className="btn-ghost">
            ← 返回
          </button>
          <nav className="flex min-w-0 flex-wrap items-center gap-1 break-all text-sm">
            {breadcrumbs.map((b, i) => (
              <span key={b.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-[var(--color-ink-faint)]">/</span>}
                <button
                  onClick={() => setCurrentPath(b.path)}
                  className={`rounded px-1.5 py-0.5 ${i === breadcrumbs.length - 1 ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]'}`}
                >
                  {b.name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名…"
            className="w-48 input-field"
          />
          <button
            onClick={() => setShowOrganize(true)}
            className="btn-ghost"
          >
            整理目录
          </button>
          <button
            onClick={() => void openInFinder(currentPath)}
            className="btn-ghost"
          >
            在 Finder 打开
          </button>
          <button
            onClick={() => void kbApi.scan(kb.id).then(load).catch(e => setMessage(String(e)))}
            className="btn-ghost"
          >
            重新扫描
          </button>
        </div>
      </div>

      {message && (
        <div className="mb-3 rounded-lg bg-[var(--color-panel-strong)]/70 p-2 text-xs text-[var(--color-ink)]" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      {undos.length > 0 && (
        <details className="card mb-4 p-3">
          <summary className="cursor-pointer text-sm">撤销记录（{undos.length}）</summary>
          {undos.map(record => <div key={record.id} className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <span>{record.ts} · {record.moves.length} 项</span>
            <button className="btn-ghost" disabled={undoBusy} onClick={() => {
              setUndoBusy(true);
              void kbApi.undo(kb.id, record.id).then(async r => {
                setMessage(r.failed.length ? `撤销部分失败：${r.failed.map(f => f.error).join('；')}` : `已撤销 ${r.moved.length} 项`);
                await load();
              }).catch(e => setMessage(String(e))).finally(() => setUndoBusy(false));
            }}>撤销这次整理</button>
          </div>)}
        </details>
      )}

      {hits !== null ? (
        <div className="card p-4">
          <h3 className="mb-3 text-sm text-[var(--color-ink-dim)]">「{query}」的 {hits.length} 个结果</h3>
          {hits.length === 0 ? (
            <div className="py-6 text-center text-[var(--color-ink-faint)]">无匹配</div>
          ) : (
            <div className="space-y-1">
              {hits.map((h) => (
                <div key={h.path} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-panel-strong)]">
                  <button
                    onClick={() => {
                      const parent = h.path.includes('/') ? h.path.slice(0, h.path.lastIndexOf('/')) : '';
                      setCurrentPath(parent);
                      setQuery('');
                      setHits(null);
                    }}
                    className="truncate font-mono text-xs text-[var(--color-ink)]"
                  >
                    {h.path}
                  </button>
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span className="text-xs text-[var(--color-ink-dim)]">{formatBytes(h.size)}</span>
                    <button onClick={() => void openInFinder(h.path)} className="text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
                      打开
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2">
            <Chart option={chartOption} onSelect={(path, kind) => { if (kind === 'dir') setCurrentPath(path); else void openInFinder(path); }} className="h-[480px] w-full" />
          </div>
          <div className="card p-4">
            <h3 className="mb-3 text-sm text-[var(--color-ink-dim)]">
              {treemap ? `${treemap.fileCount} 文件 · ${treemap.dirCount} 目录 · ${formatBytes(treemap.size)}` : '目录'}
            </h3>
            <div className="max-h-[440px] space-y-0.5 overflow-y-auto">
              {entries.map((e) => (
                <div key={e.path} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-panel-strong)]">
                  <button
                    onClick={() => (e.kind === 'dir' ? setCurrentPath(e.path) : void openInFinder(e.path))}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <span className="text-xs">{e.kind === 'dir' ? '📁' : '📄'}</span>
                    <span className="truncate">{e.name}</span>
                  </button>
                  <span className="ml-2 shrink-0 text-xs text-[var(--color-ink-dim)]">{formatBytes(e.size)}</span>
                </div>
              ))}
              {entries.length === 0 && <div className="py-6 text-center text-[var(--color-ink-faint)]">空目录</div>}
            </div>
          </div>
        </div>
      )}

      {showOrganize && (
        <OrganizeDialog
          kb={kb}
          subdir={currentPath}
          onClose={() => setShowOrganize(false)}
          onDone={(message) => {
            setMessage(message);
            void load();
          }}
        />
      )}
    </div>
  );
}
