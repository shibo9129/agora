import { useCallback, useEffect, useState } from 'react';
import { memoryApi, type HubAgentStatus, type MemoryConfig, type MemoryDocument, type MemoryEntry, type MemoryGroup } from './api';

function EnrollPanel({ onToast }: { onToast: (msg: string) => void }) {
  const [agents, setAgents] = useState<HubAgentStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await memoryApi.hubStatus();
    setAgents(r.agents);
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

  return (
    <div className="space-y-3">
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

  useEffect(() => {
    void load();
    void loadConfig();
  }, [load, loadConfig]);

  useEffect(() => {
    if (query.trim().length === 0) {
      void load();
      return;
    }
    const t = setTimeout(() => {
      void memoryApi.search(query).then((r) => setEntries(r.hits));
    }, 250);
    return () => clearTimeout(t);
  }, [query, load]);

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
      await load();
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
      await load();
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

      {toast && <div className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-strong)]/80 p-3 text-sm text-[var(--color-ink)]">{toast}</div>}

      {tab === 'enroll' && <EnrollPanel onToast={showToast} />}

      {tab === 'browse' && (
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
                          void load();
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
      )}

      {showCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowCfg(false)}>
          <div className="card dialog-panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 font-medium">中央仓库设置</h3>
            <p className="mb-3 text-xs leading-relaxed text-[var(--color-ink-dim)]">
              所有同步的记忆和精炼产物（MEMORY.md 根索引）都写入该目录。默认 <code className="font-mono">{cfg?.defaultRoot}</code>；
              也可以指向你已有的记忆库目录（例如某个 Obsidian vault 下的子文件夹），Agora 只新增/更新自己管理的文件，不碰库内其他内容。
            </p>
            <input
              value={cfgPath}
              onChange={(e) => setCfgPath(e.target.value)}
              className="input-field mb-3 w-full font-mono text-xs"
              placeholder="/Users/you/path/to/memory"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCfg(false)} className="btn-ghost">取消</button>
              <button onClick={() => void saveRootPath()} disabled={!cfgPath.trim()} className="btn-primary">
                保存并重建索引
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
