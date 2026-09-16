import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_COLORS,
  AGENT_LABELS,
  api,
  formatTokens,
  formatUSD,
  type AgentBreakdown,
  type AgentDetection,
  type CollectionReport,
  type DailyUsage,
  type HourlyUsage,
  type ModelBreakdown,
  type ProjectBreakdown,
  type UsageTotals,
} from './api';
import { Chart } from './components/Chart';
import { KbPage } from './kb/KbPage';
import { KbDetail } from './kb/KbDetail';
import type { KnowledgeBase } from './kb/api';
import { ToolsPage } from './tools/ToolsPage';
import { MemoryPage } from './memory/MemoryPage';
import { useCountUp } from './hooks/useCountUp';
import { useHubEvents } from './hooks/useHubEvents';
import { SpotlightZone } from './components/SpotlightZone';
import { AgoraLogo } from './components/AgoraLogo';
import { SettingsPanel } from './settings/SettingsPanel';
import { useSettings, CURRENCY_SYMBOLS } from './settings/settings';
import { getChartTheme, chartTooltipBase, useThemeTick } from './components/chart-theme';

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

export default function App() {
  const [page, setPage] = useState<'usage' | 'kb' | 'tools' | 'memory'>(() => {
    const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
    return h === 'kb' || h === 'tools' || h === 'memory' ? h : 'usage';
  });
  const [openKb, setOpenKb] = useState<KnowledgeBase | null>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d: { version?: string }) => setVersion(d.version ?? ''))
      .catch(() => {});
  }, []);

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

  const goto = useCallback((p: 'usage' | 'kb' | 'tools' | 'memory') => {
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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--color-edge)] bg-[var(--header-bg)] backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <AgoraLogo size={34} />
              <div className="leading-tight">
                <div className="text-gradient text-[16px] font-bold tracking-tight">Agora</div>
                <div className="text-[11px] tracking-wide text-[var(--color-ink-faint)]">本地 AI 中枢</div>
              </div>
            </div>
            <nav className="flex gap-1 rounded-2xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1.5">
              {(
                [
                  ['usage', '用量看板'],
                  ['kb', '知识库'],
                  ['tools', '工具中心'],
                  ['memory', '记忆中枢'],
                ] as const
              ).map(([p, label]) => (
                <button
                  key={p}
                  onClick={() => goto(p)}
                  className={page === p ? 'nav-tab nav-tab-active' : 'nav-tab'}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[var(--color-edge)] bg-[var(--color-panel)] px-2.5 py-1 text-[10px] tracking-wider text-[var(--color-ink-faint)]">
              {version ? `v${version}` : '…'}
            </span>
            <SettingsPanel />
          </div>
        </div>
      </header>

      <main key={`${page}${openKb?.id ?? ''}`} className="page-enter mx-auto max-w-6xl px-6 py-8">
        {page === 'usage' && <UsageDashboard />}
        {page === 'kb' && !openKb && <KbPage onOpenKb={openKbDetail} />}
        {page === 'kb' && openKb && <KbDetail kb={openKb} onBack={backToKbList} />}
        {page === 'tools' && <ToolsPage />}
        {page === 'memory' && <MemoryPage />}
      </main>
    </div>
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

  const load = useCallback(async () => {
    try {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: hub pushes usage-updated when new agent data lands (real-time watch).
  useHubEvents({
    onUsageUpdated: () => void load(),
    onAgentsUpdated: () => void load(),
  });

  const onCollect = async () => {
    setCollecting(true);
    try {
      const report = await api.collect();
      setLastReport(report);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCollecting(false);
    }
  };

  const themeTick = useThemeTick();

  const pieOption = useMemo(
    () => {
      const ct = getChartTheme();
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', valueFormatter: (v: number) => formatMoney(v), ...chartTooltipBase(ct) },
        legend: { bottom: 0, textStyle: { color: ct.legend, fontSize: 11 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
        series: [
          {
            type: 'pie' as const,
            radius: ['48%', '72%'],
            itemStyle: { borderRadius: 8, borderColor: 'rgba(0,0,0,0.25)', borderWidth: 2 },
            label: { color: ct.legend, fontSize: 11, formatter: '{b}\n{d}%' },
            data: byAgent.map((a) => ({
              name: agentLabel(a.agent),
              value: Number(a.costUSD.toFixed(4)),
              itemStyle: { color: agentColor(a.agent) },
            })),
          },
        ],
      };
    },
    [byAgent, formatMoney, themeTick],
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

      {error && (
        <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-sm text-red-300">
          {error}（请确认 agora server 已在 127.0.0.1:7878 运行）
        </div>
      )}

      {lastReport && (
        <div className="mb-4 card p-3 text-xs text-[var(--color-ink-dim)]">
          上次采集：新增 {lastReport.totals.inserted} 条 · 重复 {lastReport.totals.duplicates} 条 · 失败{' '}
          {lastReport.totals.failed} 个源（{new Date(lastReport.finishedAt).toLocaleString()}）
        </div>
      )}

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
          <h2 className="section-title mb-3">成本占比（按 Agent）</h2>
          <Chart option={pieOption} className="h-72 w-full" />
        </SpotlightZone>
        <SpotlightZone className="card p-5">
          <h2 className="section-title mb-3">{days === 1 ? '今日 Token 用量趋势（按小时）' : '每日 Token 用量趋势'}</h2>
          <Chart option={trendOption} className="h-72 w-full" />
        </SpotlightZone>
      </section>

      <section className="mb-6 card p-4">
        <h2 className="section-title mb-3">按模型</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-edge)] text-left text-[11px] text-[var(--color-ink-dim)]">
                <th className="pb-2 pr-4 font-medium">模型</th>
                <th className="pb-2 pr-4 font-medium">Agent</th>
                <th className="pb-2 pr-4 text-right font-medium">Tokens</th>
                <th className="pb-2 pr-4 text-right font-medium">输出</th>
                <th className="pb-2 pr-4 text-right font-medium">缓存读</th>
                <th className="pb-2 text-right font-medium">成本</th>
              </tr>
            </thead>
            <tbody>
              {byModel.slice(0, 15).map((m) => (
                <tr key={`${m.agent}:${m.model}`} className="table-row-hover border-b border-[var(--color-edge)] last:border-0">
                  <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-ink)]">{m.model}</td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-ink-dim)]">{agentLabel(m.agent)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink)]">{formatTokens(m.totalTokens)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(m.outputTokens)}</td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(m.cacheReadTokens)}</td>
                  <td className="num py-2.5 text-right font-semibold text-emerald-400">{formatMoney(m.costUSD)}</td>
                </tr>
              ))}
              {byModel.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--color-ink-faint)]">
                    暂无数据 — 点击「采集用量」从本地 Agent 会话记录汇总
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h2 className="section-title mb-3">按项目</h2>
          <table className="w-full text-sm">
            <tbody>
              {byProject.slice(0, 10).map((p) => (
                <tr key={p.project} className="table-row-hover border-b border-[var(--color-edge)] last:border-0">
                  <td className="max-w-0 truncate py-2.5 pr-4 font-mono text-xs text-[var(--color-ink)]" title={p.project}>
                    {p.project}
                  </td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--color-ink-dim)]">{formatTokens(p.totalTokens)}</td>
                  <td className="num py-2.5 text-right font-semibold text-emerald-400">{formatMoney(p.costUSD)}</td>
                </tr>
              ))}
              {byProject.length === 0 && (
                <tr>
                  <td className="py-8 text-center text-[var(--color-ink-faint)]">暂无数据</td>
                </tr>
              )}
            </tbody>
          </table>
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
    </div>
  );
}
