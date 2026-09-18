import { useCallback, useEffect, useState } from 'react';
import { LoadGate, usePageLoad } from '../components/LoadState';
import { memoryApi, type HubAgentStatus, type MemoryConfig, type MemoryDocument, type MemoryEntry, type MemoryGroup } from './api';
import { useHubEvents } from '../hooks/useHubEvents';

function EnrollPanel({ onToast }: { onToast: (msg: string) => void }) {
  const [agents, setAgents] = useState<HubAgentStatus[]>([]);
  const [autoEnroll, setAutoEnroll] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, cfg] = await Promise.all([memoryApi.hubStatus(), memoryApi.config()]);
    setAgents(r.agents);
    setAutoEnroll(cfg.autoEnroll);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (agent: string, enroll: boolean) => {
    setBusy(agent);
    try {
      if (enroll) await memoryApi.enroll(agent);
      else await memoryApi.unenroll(agent);
      onToast(`${enroll ? '已接入' : '已断开'} ${agent}（配置已自动备份）`);
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoEnroll = async (enabled: boolean) => {
    try {
      const next = await memoryApi.saveConfig({ autoEnroll: enabled });
      setAutoEnroll(next.autoEnroll);
      onToast(enabled ? '自动接入已开启：新检测到的 Agent 将在中枢启动时自动完成接入' : '自动接入已关闭（已接入的保持不动）');
      await load();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="card flex items-center justify-between p-4">
        <div>
          <div className="text-sm font-medium">自动接入本地 Agent</div>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-dim)]">
            开启后：中枢启动时自动检测本地已安装的 Agent 并完成接入（注册 MCP + 注入指引，全程幂等、自动备份）。
          </p>
        </div>
        {/* The knob is a flex child, not an absolutely positioned one: with no
            `left`, `position:absolute` falls back to the static position, which
            a button centers — so the "on" knob sat 12px right of the track and
            spilled out over the card's edge. */}
        <button
          onClick={() => void toggleAutoEnroll(!(autoEnroll ?? true))}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${(autoEnroll ?? true) ? 'bg-emerald-500' : 'bg-zinc-600'}`}
          role="switch"
          aria-checked={autoEnroll ?? true}
        >
          <span
            className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${(autoEnroll ?? true) ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
          />
        </button>
      </div>
      <p className="text-sm text-[var(--color-ink-dim)]">
        一键接入 = ① 把 Agora MCP server 注册进 Agent 配置（自动备份）② 在入口文件注入记忆使用指引（受管区块，可干净移除）。
      </p>
      {agents.map((a) => (
        <div key={a.agent} className="flex items-center justify-between card p-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.displayName}</span>
              {a.mcpRegistered && <span className="rounded bg-emerald-950/60 px-1.5 py-0.5 text-xs text-emerald-400">MCP 已注册</span>}
              {a.entryBlockPresent && <span className="rounded bg-blue-950/60 px-1.5 py-0.5 text-xs text-blue-400">指引已注入</span>}
            </div>
            {a.entryFilePath && <div className="mt-1 font-mono text-xs text-[var(--color-ink-dim)]">{a.entryFilePath}</div>}
          </div>
          {a.enrollable ? (
            a.mcpRegistered && a.entryBlockPresent ? (
              <button
                disabled={busy === a.agent}
                onClick={() => void act(a.agent, false)}
                className="btn-danger-ghost"
              >
                断开
              </button>
            ) : (
              <button
                disabled={busy === a.agent}
                onClick={() => void act(a.agent, true)}
                className="btn-primary"
              >
                {busy === a.agent ? '接入中…' : '一键接入'}
              </button>
            )
          ) : (
            <span className="text-xs text-[var(--color-ink-faint)]">需手动配置</span>
          )}
        </div>
      ))}
      {agents.length === 0 && <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-8 text-center text-[var(--color-ink-faint)]">未发现已安装的 Agent</div>}
    </div>
  );
}

export function MemoryPage() {
  const [tab, setTab] = useState<'browse' | 'enroll'>('browse');
  const [groups, setGroups] = useState<MemoryGroup[]>([]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<{ scope: string; group: string } | null>(null);
  const [query, setQuery] = useState('');
  const [doc, setDoc] = useState<MemoryDocument | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [cfg, setCfg] = useState<MemoryConfig | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [cfgPath, setCfgPath] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  }, []);

  const load = useCallback(async () => {
    const g = await memoryApi.groups();
    setGroups(g.groups);
    if (selectedGroup) {
      const e = await memoryApi.entries(selectedGroup.scope, selectedGroup.group);
      setEntries(e.entries);
    } else {
      const e = await memoryApi.entries();
      setEntries(e.entries);
    }
  }, [selectedGroup]);

  const loadConfig = useCallback(async () => {
    const c = await memoryApi.config();
    setCfg(c);
    setCfgPath(c.rootPath);
  }, []);

  const loadState = usePageLoad(load);
  const { run: reload } = loadState;

  useEffect(() => {
    void reload();
    void loadConfig();
  }, [reload, loadConfig]);

  // Live reload when a sync lands new memories or enrollment changes.
  useHubEvents({
    onUsageUpdated: () => void reload(),
    onAgentsUpdated: () => void reload(),
  });

  useEffect(() => {
    if (query.trim().length === 0) {
      void reload();
      return;
    }
    const t = setTimeout(() => {
      void memoryApi.search(query).then((r) => setEntries(r.hits));
    }, 250);
    return () => clearTimeout(t);
  }, [query, reload]);

  const openDoc = async (path: string) => {
    try {
      setDoc(await memoryApi.read(path));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const report = await memoryApi.sync();
      const perAgent = report.agents.filter((a) => a.synced > 0).map((a) => `${a.agent} ${a.synced}`).join(' · ');
      showToast(report.totalSynced > 0 ? `已同步 ${report.totalSynced} 条记忆（${perAgent}）` : '未发现可同步的 Agent 记忆');
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const toggleAutoSync = async (enabled: boolean) => {
    try {
      const next = await memoryApi.saveConfig({ autoSync: enabled });
      setCfg((prev) => (prev ? { ...prev, autoSync: next.autoSync } : prev));
      showToast(enabled ? '自动同步已开启：已向各 Agent 写入记忆规则，每 10 分钟自动同步' : '自动同步已关闭：规则区块已移除');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const saveRootPath = async () => {
    try {
      const next = await memoryApi.saveConfig({ rootPath: cfgPath });
      setCfg((prev) => (prev ? { ...prev, rootPath: next.rootPath } : prev));
      setShowCfg(false);
      showToast(`中央仓库已切换：${next.rootPath}（索引已重建）`);
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const saveInterval = async (minutes: number) => {
    try {
      const next = await memoryApi.saveConfig({ syncIntervalMinutes: minutes });
      setCfg((prev) => (prev ? { ...prev, syncIntervalMinutes: next.syncIntervalMinutes } : prev));
      showToast(`同步间隔已设为 ${next.syncIntervalMinutes} 分钟${next.autoSync ? '（定时任务已重启）' : '（开启自动同步后生效）'}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">记忆中枢</h2>
          <nav className="flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
            {(
              [
                ['browse', '浏览'],
                ['enroll', 'Agent 接入'],
              ] as const
            ).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} className={tab === t ? 'nav-tab nav-tab-active' : 'nav-tab'}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        {tab === 'browse' && (
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-ink-dim)]" title="开启后：向各 Agent 写入记忆规则，并每 10 分钟自动同步">
              <input
                type="checkbox"
                checked={cfg?.autoSync ?? false}
                onChange={(e) => void toggleAutoSync(e.target.checked)}
                className="accent-emerald-500"
              />
              自动同步
            </label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索记忆…"
              className="w-44 input-field"
            />
            <button onClick={() => setShowCfg(true)} className="btn-ghost" title={cfg?.rootPath}>
              仓库设置
            </button>
            <button onClick={() => void runSync()} disabled={syncing} className="btn-primary">
              {syncing ? '同步中…' : '⟳ 同步'}
            </button>
          </div>
        )}
      </div>

      {(toast ?? (loadState.loaded ? loadState.error : null)) && (
        <div className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-strong)]/80 p-3 text-sm text-[var(--color-ink)]">
          {toast ?? `刷新失败：${loadState.error ?? ''}`}
        </div>
      )}

      {tab === 'enroll' && <EnrollPanel onToast={showToast} />}

      {tab === 'browse' && (
        <LoadGate
          state={loadState}
          skeleton={
            <div className="grid gap-4 lg:grid-cols-4">
              <div className="skeleton h-64" />
              <div className="skeleton h-64 lg:col-span-3" />
            </div>
          }
        >
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="card p-3">
            <button
              onClick={() => setSelectedGroup(null)}
              className={`mb-2 w-full rounded-lg px-2 py-1.5 text-left text-sm ${selectedGroup === null ? 'bg-[var(--color-panel-strong)]' : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-strong)]/50'}`}
            >
              全部（{groups.reduce((s, g) => s + g.count, 0)}）
            </button>
            <div className="space-y-0.5">
              {groups.map((g) => (
                <button
                  key={`${g.scope}/${g.group}`}
                  onClick={() => setSelectedGroup({ scope: g.scope, group: g.group })}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                    selectedGroup?.scope === g.scope && selectedGroup?.group === g.group
                      ? 'bg-[var(--color-panel-strong)]'
                      : 'text-[var(--color-ink-dim)] hover:bg-[var(--color-panel-strong)]/50'
                  }`}
                >
                  <span className="text-xs text-[var(--color-ink-faint)]">[{g.scope}]</span> {g.group}
                  <span className="ml-1 text-xs text-[var(--color-ink-faint)]">{g.count}</span>
                </button>
              ))}
              {groups.length === 0 && <div className="px-2 py-4 text-center text-xs text-[var(--color-ink-faint)]">暂无记忆</div>}
            </div>
          </div>

          <div className="lg:col-span-3">
            {doc ? (
              <div className="card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">{doc.name}</h3>
                    <div className="text-xs text-[var(--color-ink-dim)]">
                      {doc.path} · {doc.type}
                      {doc.by ? ` · by ${doc.by}` : ''} · {new Date(doc.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        void memoryApi.remove(doc.path).then(() => {
                          showToast('已删除');
                          setDoc(null);
                          void reload();
                        });
                      }}
                      className="btn-danger-ghost"
                    >
                      删除
                    </button>
                    <button onClick={() => setDoc(null)} className="btn-ghost">
                      返回列表
                    </button>
                  </div>
                </div>
                <div className="mb-3 rounded-lg bg-[var(--color-panel-strong)] p-2 text-sm text-[var(--color-ink)]">{doc.abstract}</div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-[var(--color-ink)]">{doc.body}</pre>
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((e) => (
                  <button
                    key={e.path}
                    onClick={() => void openDoc(e.path)}
                    className="flex w-full items-center justify-between card px-4 py-3 text-left hover:border-zinc-600"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{e.abstract || e.name}</div>
                      <div className="mt-0.5 font-mono text-xs text-[var(--color-ink-dim)]">
                        {e.path} · {e.type}
                        {e.by ? ` · ${e.by}` : ''}
                      </div>
                    </div>
                    <span className="ml-3 shrink-0 text-xs text-[var(--color-ink-faint)]">{new Date(e.updatedAt).toLocaleDateString()}</span>
                  </button>
                ))}
                {entries.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-12 text-center text-[var(--color-ink-faint)]">
                    暂无记忆 — 点击「⟳ 同步」从各 Agent 汇聚，或在「Agent 接入」里一键接入
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        </LoadGate>
      )}

      {showCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowCfg(false)}>
          <div className="card-pop dialog-panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 font-medium">中央仓库设置</h3>
            <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
              所有同步的记忆和精炼产物（MEMORY.md 根索引）都写入该目录。默认 <code className="font-mono">{cfg?.defaultRoot}</code>；
              也可以指向你已有的记忆库目录（例如某个 Obsidian vault 下的子文件夹），Agora 只新增/更新自己管理的文件，不碰库内其他内容。
            </p>
            <input
              value={cfgPath}
              onChange={(e) => setCfgPath(e.target.value)}
              className="input-field mb-4 w-full font-mono text-xs"
              placeholder="/Users/you/path/to/memory"
            />
            <div className="mb-4">
              <div className="section-title mb-2">自动同步间隔</div>
              <div className="flex flex-wrap items-center gap-2">
                {[5, 10, 30, 60].map((m) => (
                  <button
                    key={m}
                    onClick={() => void saveInterval(m)}
                    className={cfg?.syncIntervalMinutes === m ? 'nav-tab nav-tab-active' : 'nav-tab border border-[var(--color-edge)]'}
                  >
                    {m} 分钟
                  </button>
                ))}
                <span className="flex items-center gap-1 text-xs text-[var(--color-ink-dim)]">
                  自定义
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={cfg?.syncIntervalMinutes ?? 10}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 1 && v <= 1440) void saveInterval(Math.round(v));
                    }}
                    className="input-field w-16 !px-2 !py-1 text-center"
                  />
                  分钟
                </span>
              </div>
              <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
                需开启「自动同步」才生效；同步只读取各 Agent 记忆做精炼复制，不会修改 Agent 原有记忆文件。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCfg(false)} className="btn-ghost">关闭</button>
              <button onClick={() => void saveRootPath()} disabled={!cfgPath.trim()} className="btn-primary">
                保存路径并重建索引
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
