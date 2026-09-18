import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_COLORS,
  AGENT_LABELS,
  api,
  formatTokens,
  formatUSD,
  type AgentBreakdown,
  type AgentDetection,
  type HourlyUsage,
  type CollectionReport,
  type DailyUsage,
  type ModelBreakdown,
  type ProjectBreakdown,
  type UsageTotals,
} from './api';
import { Chart } from './components/Chart';
import { LoadGate, usePageLoad } from './components/LoadState';
import type { KnowledgeBase } from './kb/api';
import { useCountUp } from './hooks/useCountUp';
import { useHubEvents } from './hooks/useHubEvents';
import { SpotlightZone } from './components/SpotlightZone';
import { Sidebar, type PageId } from './components/Sidebar';
import { onWindowDragMouseDown } from './desktop';
import { useSettings, CURRENCY_SYMBOLS } from './settings/settings';
import { getChartTheme, chartTooltipBase, useThemeTick } from './components/chart-theme';

// Code-split every page but the default landing one — keeps first paint to
// just the usage dashboard + echarts instead of the whole app up front.
const KbPage = lazy(() => import('./kb/KbPage').then((m) => ({ default: m.KbPage })));
const KbDetail = lazy(() => import('./kb/KbDetail').then((m) => ({ default: m.KbDetail })));
const ToolsPage = lazy(() => import('./tools/ToolsPage').then((m) => ({ default: m.ToolsPage })));
const MemoryPage = lazy(() => import('./memory/MemoryPage').then((m) => ({ default: m.MemoryPage })));

const PAGE_SHORTCUTS: Record<string, PageId> = { '1': 'usage', '2': 'kb', '3': 'tools', '4': 'memory' };

function PageSkeleton() {
  return (
    <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skeleton h-32" />
      ))}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<PageId>(() => {
    const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
    return h === 'kb' || h === 'tools' || h === 'memory' ? h : 'usage';
  });
  const [openKb, setOpenKb] = useState<KnowledgeBase | null>(null);

  // Deep-link: #/kb/<id> opens a kb detail directly.
  useEffect(() => {
    const h = window.location.hash.replace(/^#\/?/, '');
    if (h.startsWith('kb/')) {
      const id = h.slice(3);
      void import('./kb/api').then(({ kbApi }) =>
        kbApi.list().then(({ kbs }) => {
          const found = kbs.find((k) => k.id === id);
          if (found) {
            setPage('kb');
            setOpenKb(found);
          }
        }),
      );
    }
  }, []);

  const goto = useCallback((p: PageId) => {
    setPage(p);
    setOpenKb(null);
    window.location.hash = p === 'usage' ? '/' : `/${p}`;
  }, []);

  const openKbDetail = useCallback((kb: KnowledgeBase) => {
    setOpenKb(kb);
    window.location.hash = `/kb/${kb.id}`;
  }, []);

  const backToKbList = useCallback(() => {
    setOpenKb(null);
    window.location.hash = '/kb';
  }, []);

  // The native menu bar (视图 menu) drives navigation through this event
  // rather than window.navigate(), so switching sections from the menu is the
  // same in-app transition as clicking the sidebar — no reload.
  useEffect(() => {
    const onNav = (e: Event) => {
      const section = (e as CustomEvent<string>).detail;
      if (section === 'usage' || section === 'kb' || section === 'tools' || section === 'memory') goto(section);
    };
    window.addEventListener('agora:nav', onNav);
    return () => window.removeEventListener('agora:nav', onNav);
  }, [goto]);

  // macOS-native chrome: Cmd+1..4 switches sections, Cmd+, opens settings —
  // without these a Tauri window just feels like a webpage, not an app.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === ',') {
        e.preventDefault();
        window.dispatchEvent(new Event('agora:toggle-settings'));
        return;
      }
      const targetPage = PAGE_SHORTCUTS[e.key];
      if (targetPage) {
        e.preventDefault();
        goto(targetPage);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goto]);

  return (
    <div className="app-shell">
      <div className="window-drag-bar" data-tauri-drag-region onMouseDown={onWindowDragMouseDown} />
      <Sidebar page={page} onNavigate={goto} />
      <main key={`${page}${openKb?.id ?? ''}`} className="page-enter app-main">
        <Suspense fallback={<PageSkeleton />}>
          {page === 'usage' && <UsageDashboard />}
          {page === 'kb' && !openKb && <KbPage onOpenKb={openKbDetail} />}
          {page === 'kb' && openKb && <KbDetail kb={openKb} onBack={backToKbList} />}
          {page === 'tools' && <ToolsPage />}
          {page === 'memory' && <MemoryPage />}
        </Suspense>
      </main>
    </div>
  );
}

const DAY_OPTIONS = [
  { label: '今天', value: 1 },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '全部', value: 0 },
] as const;

function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id;
}

function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? '#a1a1aa';
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const w = 120;
  const h = 28;
  const max = Math.max(...data, 1);
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * (h - 3) - 1}`).join(' ');
  const id = useMemo(() => `sg-${Math.random().toString(36).slice(2, 7)}`, []);
  return (
    <svg width={w} height={h} className="opacity-90">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${points} ${w},${h}`} fill={`url(#${id})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function StatCard({
  title,
  rawValue,
  format,
  sub,
  accent,
  icon,
  spark,
}: {
  title: string;
  rawValue: number;
  format: (n: number) => string;
  sub?: string | undefined;
  accent: string;
  icon: string;
  spark?: number[] | undefined;
}) {
  const animated = useCountUp(rawValue);
  return (
    <div className="card card-hover relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-[0.12] blur-2xl"
        style={{ background: accent }}
      />
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="icon-chip" style={{ background: `${accent}1f`, color: accent }}>
              <span className="text-[15px] leading-none">{icon}</span>
            </span>
            <span className="section-title">{title}</span>
          </div>
          <div className="num text-gradient mt-3 text-[32px] font-semibold leading-none tracking-tight">
            {format(animated)}
          </div>
        </div>
        {spark && <Sparkline data={spark} color={accent} />}
      </div>
      {sub && <div className="mt-2.5 text-[11px] leading-relaxed text-[var(--color-ink-dim)]">{sub}</div>}
    </div>
  );
}


/** How often the dashboard re-queries on its own (ms). */
const AUTO_REFRESH_MS = 60_000;

const RANGE_LABEL: Record<number, string> = { 1: '今天', 7: '近 7 天', 30: '近 30 天', 0: '全部时间' };

/**
 * Split a project key for display. Real cwds arrive as absolute paths, so the
 * directory name is the readable part and the parent is context; legacy rows
 * only have the flattened slug (`Users-me-Code-x`), which has to be shown
 * whole because the flattening is not reversible.
 */
function projectName(row: ProjectBreakdown): { label: string; parent: string; full: string } {
  const full = row.project;
  if (row.projectPath) {
    const parts = row.projectPath.split('/').filter(Boolean);
    const label = parts[parts.length - 1] ?? row.projectPath;
    return { label, parent: `/${parts.slice(0, -1).join('/')}`, full: row.projectPath };
  }
  if (full === '(unknown)') return { label: '未记录目录', parent: '', full };
  return { label: full, parent: '', full };
}

type SortDir = 'asc' | 'desc';

function useSort<K extends string>(initialKey: K) {
  const [key, setKey] = useState<K>(initialKey);
  const [dir, setDir] = useState<SortDir>('desc');
  const toggle = useCallback(
    (next: K) => {
      // New column starts on its most useful end (big numbers first); the same
      // column flips.
      setKey((prev) => {
        if (prev === next) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        else setDir('desc');
        return next;
      });
    },
    [],
  );
  const sort = useCallback(
    <T,>(rows: T[], value: (row: T, key: K) => number | string): T[] =>
      [...rows].sort((a, b) => {
        const va = value(a, key);
        const vb = value(b, key);
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
        return dir === 'asc' ? cmp : -cmp;
      }),
    [key, dir],
  );
  return { key, dir, toggle, sort };
}

function SortHeader<K extends string>({
  label,
  column,
  sort,
  align = 'left',
}: {
  label: string;
  column: K;
  sort: { key: K; dir: SortDir; toggle: (k: K) => void };
  align?: 'left' | 'right';
}) {
  const active = sort.key === column;
  return (
    <th className={`pb-2 pr-4 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => sort.toggle(column)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-[var(--color-ink)] ${
          active ? 'text-[var(--color-ink)]' : ''
        }`}
        title={`按${label}排序`}
      >
        {label}
        <span className={active ? 'opacity-90' : 'opacity-30'}>{active && sort.dir === 'asc' ? '▲' : '▼'}</span>
      </button>
    </th>
  );
}

function UsageDashboard() {
  const { formatMoney, settings } = useSettings();
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<UsageTotals | null>(null);
  const [byAgent, setByAgent] = useState<AgentBreakdown[]>([]);
  const [byModel, setByModel] = useState<ModelBreakdown[]>([]);
  const [byProject, setByProject] = useState<ProjectBreakdown[]>([]);
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [hourly, setHourly] = useState<HourlyUsage[]>([]);
  const [agents, setAgents] = useState<AgentDetection[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [lastReport, setLastReport] = useState<CollectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rejections propagate to usePageLoad (skeleton → content → error), instead
  // of being swallowed into a banner the empty state contradicts.
  const load = useCallback(async () => {
    const d = days === 0 ? undefined : days;
    const [s, a, m, p, dy, ag, hy] = await Promise.all([
      api.summary(d),
      api.byAgent(d),
      api.byModel(d),
      api.byProject(d),
      api.daily(days === 0 ? 3650 : days),
      api.agents(),
      // Intraday series only needed on the 今天 view; still cheap to fetch.
      days === 1 ? api.hourly() : Promise.resolve({ rows: [] }),
    ]);
    setSummary(s);
    setByAgent(a.rows);
    setByModel(m.rows);
    setByProject(p.rows);
    setDaily(dy.rows);
    setAgents(ag.agents);
    setHourly(hy.rows);
    setError(null);
  }, [days]);

  const loadState = usePageLoad(load);
  const { run: reload } = loadState;
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    await reload();
    setRefreshedAt(new Date());
  }, [reload]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live: hub pushes usage-updated when new agent data lands (real-time watch).
  useHubEvents({
    onUsageUpdated: () => void refresh(),
    onAgentsUpdated: () => void refresh(),
  });

  // Periodic re-query on top of the push channel: hub events only fire for
  // sources the watcher sees, so a timer is what guarantees every panel on
  // this page — cards, charts, model and project tables — keeps agreeing with
  // the database and with the selected range. Paused while the window is
  // hidden so a backgrounded app is not polling all night.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  const onCollect = async () => {
    setCollecting(true);
    try {
      const report = await api.collect();
      setLastReport(report);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCollecting(false);
    }
  };

  const themeTick = useThemeTick();
  const modelSort = useSort<'model' | 'agent' | 'totalTokens' | 'outputTokens' | 'cacheReadTokens' | 'costUSD'>(
    'costUSD',
  );
  const projectSort = useSort<'project' | 'totalTokens' | 'costUSD'>('costUSD');
  const [showAllModels, setShowAllModels] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);

  const sortedModels = useMemo(
    () => modelSort.sort(byModel, (row, key) => (key === 'agent' ? agentLabel(row.agent) : row[key])),
    [byModel, modelSort],
  );
  const sortedProjects = useMemo(
    () => projectSort.sort(byProject, (row, key) => (key === 'project' ? projectName(row).label : row[key])),
    [byProject, projectSort],
  );
  const rangeLabel = RANGE_LABEL[days] ?? `近 ${days} 天`;

  const pieTotal = useMemo(() => byAgent.reduce((sum, a) => sum + a.totalTokens, 0), [byAgent]);

  const pieOption = useMemo(
    () => {
      const ct = getChartTheme();
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', valueFormatter: (v: number) => formatTokens(v), ...chartTooltipBase(ct) },
        legend: { bottom: 0, textStyle: { color: ct.legend, fontSize: 11 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
        series: [
          {
            type: 'pie' as const,
            // A slightly thicker ring so an inside "10.9%" clears both edges.
            radius: ['42%', '72%'],
            itemStyle: { borderRadius: 8, borderColor: 'rgba(0,0,0,0.25)', borderWidth: 2 },
            // Shares ride inside the ring instead of on leader lines: the old
            // callouts fanned out to the left, collided with each other and
            // got ellipsized ("H… 9…") as soon as the window narrowed. Names
            // live in the legend below and in the tooltip; slices too thin to
            // hold their own text (<5%) simply go unlabelled.
            label: { position: 'inside', formatter: '{d}%', color: '#fff', fontSize: 10, fontWeight: 600 },
            labelLine: { show: false },
            labelLayout: { hideOverlap: true },
            data: byAgent.map((a) => {
              const share = pieTotal > 0 ? (a.totalTokens / pieTotal) * 100 : 0;
              return {
                name: agentLabel(a.agent),
                value: a.totalTokens,
                itemStyle: { color: agentColor(a.agent) },
                ...(share < 5 ? { label: { show: false } } : {}),
              };
            }),
          },
        ],
      };
    },
    [byAgent, pieTotal, themeTick],
  );

  const dailyTotalCost = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const d of daily) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.costUSD);
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }, [daily, formatMoney, settings.currency]);

  const dailyTotalTokens = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const d of daily) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.totalTokens);
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }, [daily, formatMoney, settings.currency]);

  const trendOption = useMemo(() => {
    // 今天: intraday hour scale; other ranges: per-day scale.
    const hourlyView = days === 1;
    let categories: string[];
    let seriesFor: (agent: string) => number[];
    if (hourlyView) {
      const nowHour = new Date().getHours();
      const hours = Array.from({ length: nowHour + 1 }, (_, i) => String(i).padStart(2, '0'));
      categories = hours.map((h) => `${h}:00`);
      seriesFor = (agent) =>
        hours.map((h) => hourly.find((r) => r.hour === h && r.agent === agent)?.totalTokens ?? 0);
    } else {
      const daysList = [...new Set(daily.map((d) => d.day))].sort();
      categories = daysList;
      seriesFor = (agent) =>
        daysList.map((day) => daily.find((d) => d.day === day && d.agent === agent)?.totalTokens ?? 0);
    }
    const agentsList = [...new Set((hourlyView ? hourly : daily).map((d) => d.agent))];
    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number) => formatTokens(v),
        ...chartTooltipBase(getChartTheme()),
        axisPointer: {
          type: 'line',
          lineStyle: { color: 'rgba(128,128,140,0.3)', type: 'dashed' },
        },
      },
      legend: { bottom: 0, textStyle: { color: getChartTheme().legend, fontSize: 11 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
      grid: { left: 56, right: 16, top: 16, bottom: 58 },
      xAxis: {
        type: 'category' as const,
        data: categories,
        boundaryGap: false,
        axisLabel: { color: getChartTheme().axis, fontSize: 11 },
        axisLine: { lineStyle: { color: getChartTheme().grid } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: getChartTheme().axis, fontSize: 11, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: getChartTheme().grid } },
      },
      // Independent lines (never stacked): each agent's line must sit at its own
      // value — stacking made small agents float at the top of the pile.
      series: agentsList.map((agent) => {
        const color = agentColor(agent);
        return {
          name: agentLabel(agent),
          type: 'line' as const,
          smooth: 0.35,
          symbol: 'none',
          lineStyle: { width: 2, color },
          itemStyle: { color },
          emphasis: { focus: 'series' as const },
          data: seriesFor(agent),
        };
      }),
    };
  }, [daily, hourly, days, themeTick]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-end gap-3">
        <span className="mr-auto text-[11px] text-[var(--color-ink-faint)]">
          全页按「{rangeLabel}」联动查询
          {refreshedAt && ` · 每分钟自动刷新，上次 ${refreshedAt.toLocaleTimeString()}`}
        </span>
        <div className="flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setDays(o.value)}
              className={days === o.value ? 'nav-tab nav-tab-active' : 'nav-tab'}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button onClick={() => void onCollect()} disabled={collecting} className="btn-primary">
          {collecting ? '采集中…' : '采集用量'}
        </button>
      </div>

      {(error ?? (loadState.loaded ? loadState.error : null)) && (
        <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-sm text-red-300">
          {error ?? loadState.error}
        </div>
      )}

      {lastReport && (
        <div className="mb-4 card p-3 text-xs text-[var(--color-ink-dim)]">
          上次采集：新增 {lastReport.totals.inserted} 条 · 重复 {lastReport.totals.duplicates} 条 · 失败{' '}
          {lastReport.totals.failed} 个源（{new Date(lastReport.finishedAt).toLocaleString()}）
        </div>
      )}

      <LoadGate
        state={loadState}
        skeleton={
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-28" />
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="skeleton h-72" />
              <div className="skeleton h-72" />
            </div>
          </div>
        }
      >
      <section className="stagger mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          title="总成本"
          icon="◆"
          accent="#34d399"
          rawValue={summary?.costUSD ?? 0}
          format={formatMoney}
          sub="按 LiteLLM 定价计算"
          spark={dailyTotalCost}
        />
        <StatCard
          title="总 Tokens"
          icon="▤"
          accent="#818cf8"
          rawValue={summary?.totalTokens ?? 0}
          format={formatTokens}
          sub={`${summary?.calls ?? 0} 次调用`}
          spark={dailyTotalTokens}
        />
        <StatCard
          title="缓存读取"
          icon="◈"
          accent="#22d3ee"
          rawValue={summary?.cacheReadTokens ?? 0}
          format={formatTokens}
          sub={summary && summary.totalTokens > 0 ? `占总量 ${((summary.cacheReadTokens / summary.totalTokens) * 100).toFixed(1)}%` : undefined}
        />
        <StatCard
          title="输出 Tokens"
          icon="↗"
          accent="#fbbf24"
          rawValue={summary?.outputTokens ?? 0}
          format={formatTokens}
          sub={summary ? `推理 ${formatTokens(summary.reasoningTokens)}` : undefined}
        />
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <SpotlightZone className="card p-5">
          <h2 className="section-title mb-3">Token 占比（按 Agent）</h2>
          <Chart option={pieOption} className="h-72 w-full" />
        </SpotlightZone>
        <SpotlightZone className="card p-5">
          <h2 className="section-title mb-3">{days === 1 ? '今日 Token 用量趋势（按小时）' : '每日 Token 用量趋势'}</h2>
          <Chart option={trendOption} className="h-72 w-full" />
        </SpotlightZone>
      </section>

      <section className="mb-6 card p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="section-title">按模型</h2>
          <span className="text-[11px] text-[var(--color-ink-faint)]">
            {rangeLabel} · {byModel.length} 个模型 · 点击表头排序
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-edge)] text-left text-[11px] text-[var(--color-ink-dim)]">
                <SortHeader label="模型" column="model" sort={modelSort} />
                <SortHeader label="Agent" column="agent" sort={modelSort} />
                <SortHeader label="Tokens" column="totalTokens" sort={modelSort} align="right" />
                <SortHeader label="输出" column="outputTokens" sort={modelSort} align="right" />
                <SortHeader label="缓存读" column="cacheReadTokens" sort={modelSort} align="right" />
                <SortHeader label="成本" column="costUSD" sort={modelSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {(showAllModels ? sortedModels : sortedModels.slice(0, 15)).map((m) => (
                <tr key={`${m.agent}:${m.model}`} className="table-row-hover border-b border-[var(--color-edge)] last:border-0">
                  <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-ink)]">{m.model}</td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-ink-dim)]">{agentLabel(m.agent)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink)]">{formatTokens(m.totalTokens)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(m.outputTokens)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(m.cacheReadTokens)}</td>
                  <td className="num py-2.5 pr-4 text-right font-semibold text-emerald-400">{formatMoney(m.costUSD)}</td>
                </tr>
              ))}
              {byModel.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--color-ink-faint)]">
                    {days === 0
                      ? '暂无数据 — 点击「采集用量」从本地 Agent 会话记录汇总'
                      : `${rangeLabel}内没有用量 — 换个时间范围，或点击「采集用量」`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sortedModels.length > 15 && (
          <button onClick={() => setShowAllModels((v) => !v)} className="mt-3 text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
            {showAllModels ? '收起' : `展开全部 ${sortedModels.length} 个模型`}
          </button>
        )}
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="section-title">按项目</h2>
            <span className="text-[11px] text-[var(--color-ink-faint)]">
              {rangeLabel} · {byProject.length} 个项目
            </span>
          </div>
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-[var(--color-edge)] text-left text-[11px] text-[var(--color-ink-dim)]">
                <SortHeader label="项目" column="project" sort={projectSort} />
                <SortHeader label="Tokens" column="totalTokens" sort={projectSort} align="right" />
                <SortHeader label="成本" column="costUSD" sort={projectSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {(showAllProjects ? sortedProjects : sortedProjects.slice(0, 10)).map((row) => {
                const name = projectName(row);
                return (
                  <tr key={row.project} className="table-row-hover border-b border-[var(--color-edge)] last:border-0">
                    {/* The directory name carries the meaning, so it gets the
                        full-strength type and never truncates first; the parent
                        path is context and is allowed to clip. */}
                    <td className="py-2.5 pr-4" title={name.full}>
                      <div className="truncate text-[13px] text-[var(--color-ink)]">{name.label}</div>
                      {name.parent && (
                        <div className="truncate font-mono text-[10px] text-[var(--color-ink-faint)]">{name.parent}</div>
                      )}
                    </td>
                    <td className="num w-24 py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(row.totalTokens)}</td>
                    <td className="num w-24 py-2.5 pr-4 text-right font-semibold text-emerald-400">{formatMoney(row.costUSD)}</td>
                  </tr>
                );
              })}
              {byProject.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-8 text-center text-[var(--color-ink-faint)]">暂无数据</td>
                </tr>
              )}
            </tbody>
          </table>
          {sortedProjects.length > 10 && (
            <button onClick={() => setShowAllProjects((v) => !v)} className="mt-3 text-xs text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]">
              {showAllProjects ? '收起' : `展开全部 ${sortedProjects.length} 个项目`}
            </button>
          )}
        </div>
        <div className="card p-4">
          <h2 className="section-title mb-3">已检测的 Agent</h2>
          <div className="space-y-1.5">
            {agents
              .filter((a) => a.presence !== 'absent')
              .map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-2">
                  <div>
                    <span className="text-sm font-medium">{a.displayName}</span>
                    <span className="ml-2 text-[11px] text-[var(--color-ink-faint)]">{a.category}</span>
                    {a.presence === 'residual' && (
                      <span className="badge badge-amber ml-2" title="配置目录存在，但应用本体未找到（已卸载或未安装）">
                        配置残留
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {a.detail && <span className="text-[11px] text-[var(--color-ink-dim)]">{a.detail}</span>}
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        a.presence === 'installed' ? 'bg-emerald-400' : 'bg-amber-400/70'
                      }`}
                      style={a.presence === 'installed' ? { boxShadow: '0 0 6px #34d399' } : undefined}
                      title={a.presence === 'installed' ? a.configHome : `配置残留：${a.configHome}`}
                    />
                  </div>
                </div>
              ))}
          </div>
        </div>
      </section>
      </LoadGate>
    </div>
  );
}
