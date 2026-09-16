import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  toolsApi,
  type AgentDetection,
  type HealthIssue,
  type InstalledSkill,
  type RegistryServer,
  type UnifiedMcpServer,
  type UnifiedSkill,
  type UpdateStatus,
} from './api';
import { ConfirmDialog } from '../components/ConfirmDialog';

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  cursor: 'Cursor',
  hermes: 'Hermes',
  pi: 'Pi',
  'shared-pool': '共享池',
  'agora-store': 'Agora 仓库',
};

function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id;
}

function useToast(): [string | null, (msg: string) => void] {
  const [toast, setToast] = useState<string | null>(null);
  const show = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);
  return [toast, show];
}

// ── Skill install dialog + store panel ────────────────────────────────────

function InstallDialog({
  linkable,
  onClose,
  onInstalled,
  onError,
}: {
  /** Linkable agents actually installed on this machine. */
  linkable: string[];
  onClose: () => void;
  onInstalled: () => void;
  onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<'git' | 'local'>('git');
  const [url, setUrl] = useState('');
  const [linkTo, setLinkTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const source = mode === 'git' ? { type: 'git' as const, url } : { type: 'local' as const, path: url };
      const r = await toolsApi.installSkill(source, [...linkTo]);
      if (r.installed.length === 0) {
        setResult(`未安装任何 skill：${r.skipped.map((s) => s.reason).join('；') || '未知原因'}`);
      } else if (r.skipped.length || r.linkedTo.some(l => l.action.startsWith('failed:'))) {
        setResult(`已安装 ${r.installed.length} 项；部分操作未完成：${[...r.skipped.map(s => s.reason), ...r.linkedTo.filter(l => l.action.startsWith('failed:')).map(l => `${l.agent}: ${l.action}`)].join('；')}`);
        onInstalled();
      } else {
        onError(`已安装 ${r.installed.map((s) => s.name).join('、')}${r.linkedTo.length > 0 ? ` 并启用到 ${r.linkedTo.length} 处` : ''}`);
        onInstalled();
        onClose();
      }
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md card-pop p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 font-medium">安装 Skill 到中央仓库</h3>
        <div className="mb-3 flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
          {(
            [
              ['git', 'Git 仓库'],
              ['local', '本地目录'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={mode === m ? 'nav-tab nav-tab-active flex-1 text-center' : 'nav-tab flex-1 text-center'}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={mode === 'git' ? 'https://github.com/owner/repo 或 …/tree/main/skills/x' : '/abs/path/to/skill'}
          className="mb-3 w-full input-field font-mono text-xs"
        />
        <div className="mb-3">
          <div className="mb-1 text-xs text-[var(--color-ink-dim)]">安装后立即启用（创建链接）到：</div>
          <div className="flex flex-wrap gap-2">
            {linkable.map((a) => (
              <label key={a} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-edge)] px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={linkTo.has(a)}
                  onChange={(e) => {
                    const next = new Set(linkTo);
                    if (e.target.checked) next.add(a);
                    else next.delete(a);
                    setLinkTo(next);
                  }}
                />
                {agentLabel(a)}
              </label>
            ))}
            {linkable.length === 0 && <span className="text-xs text-[var(--color-ink-faint)]">未检测到已安装的 Agent</span>}
          </div>
        </div>
        {result && <div className="mb-3 rounded-lg bg-red-950/50 p-2 text-xs text-red-300">{result}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">取消</button>
          <button
            onClick={() => void submit()}
            disabled={busy || !url.trim()}
            className="btn-primary"
          >
            {busy ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StorePanel({
  installed,
  statuses,
  onChanged,
  onError,
}: {
  installed: InstalledSkill[];
  statuses: UpdateStatus[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (installed.length === 0) return null;

  const act = async (name: string, action: 'update' | 'uninstall') => {
    setBusy(name);
    try {
      if (action === 'update') {
        const r = await toolsApi.updateSkill(name);
        if (!r.installed.length) throw new Error(r.skipped.map(s => s.reason).join('；') || '未完成更新');
        onError(`已更新 ${name}`);
      } else {
        const r = await toolsApi.uninstallSkill(name);
        onError(`已卸载 ${name}（清理 ${r.unlinked.length} 处链接）${r.cleanupErrors?.length ? `；${r.cleanupErrors.length} 处链接清理失败：${r.cleanupErrors.map(e => e.path).join("、")}` : ""}`);
      }
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-4 card p-4">
      <h3 className="mb-3 text-sm font-medium text-[var(--color-ink-dim)]">中央仓库（{installed.length}）</h3>
      <div className="space-y-1">
        {installed.map((s) => {
          const st = statuses.find((x) => x.name === s.name);
          return (
            <div key={s.name} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-panel-strong)]/50">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <span className="truncate font-mono text-xs text-[var(--color-ink-dim)]">
                  {s.source.type === 'git' ? s.source.url : s.source.path}
                </span>
                {st?.updateAvailable && (
                  <span className="rounded bg-yellow-950/60 px-1.5 py-0.5 text-xs text-yellow-400">有更新</span>
                )}
              </div>
              <div className="ml-3 flex shrink-0 gap-1">
                {st?.updateAvailable && (
                  <button
                    disabled={busy === s.name}
                    onClick={() => void act(s.name, 'update')}
                    className="rounded-lg bg-yellow-600/80 px-2.5 py-1 text-xs font-medium text-white hover:bg-yellow-500"
                  >
                    更新
                  </button>
                )}
                <button
                  disabled={busy === s.name}
                  onClick={() => void act(s.name, 'uninstall')}
                  className="rounded-lg border border-[var(--color-edge-strong)] px-2.5 py-1 text-xs text-[var(--color-ink-dim)] hover:border-red-600 hover:text-red-400"
                >
                  卸载
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Skills matrix ─────────────────────────────────────────────────────────

function SkillsMatrix({
  skills,
  agents,
  onChanged,
  onError,
}: {
  skills: UnifiedSkill[];
  /** Linkable agents actually installed on this machine (detection-driven). */
  agents: string[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ skill: UnifiedSkill; agent: string; enable: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(
    () => skills.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())),
    [skills, query],
  );

  const runToggle = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await toolsApi.toggleSkill(pending.skill.name, pending.agent, pending.enable);
      onError(`${pending.skill.name} @ ${agentLabel(pending.agent)}：${r.detail}`);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  if (agents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-8 text-center text-[var(--color-ink-faint)]">
        未检测到已安装且支持 skills 的 Agent（Claude Code / Codex / OpenCode / Gemini CLI / Hermes）
      </div>
    );
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`搜索 ${skills.length} 个 skill…`}
        className="mb-3 w-64 input-field"
      />
      <div className="overflow-x-auto card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-edge)] text-left text-xs text-[var(--color-ink-dim)]">
              <th className="px-4 py-2 font-medium">Skill</th>
              {agents.map((a) => (
                <th key={a} className="px-2 py-2 text-center font-medium">
                  {agentLabel(a)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((skill) => (
              <tr key={skill.name} className="border-b border-[var(--color-edge)]/50 last:border-0 hover:bg-[var(--color-panel-strong)]/30">
                <td className="px-4 py-2">
                  <div className="font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="max-w-md truncate text-xs text-[var(--color-ink-dim)]" title={skill.description}>
                      {skill.description}
                    </div>
                  )}
                </td>
                {agents.map((agent) => {
                  const loc = skill.locations.find((l) => l.agent === agent);
                  if (loc?.kind === 'real') {
                    return (
                      <td key={agent} className="px-2 py-2 text-center" title={`实体安装：${loc.path}（实体文件不通过勾选管理）`}>
                        <span className="text-xs text-emerald-500">实体</span>
                      </td>
                    );
                  }
                  const broken = loc?.linkOk === false;
                  const enabled = !!loc && !broken;
                  return (
                    <td key={agent} className="px-2 py-2 text-center">
                      <button
                        onClick={() => setPending({ skill, agent, enable: !loc })}
                        className={`inline-flex h-4 w-4 items-center justify-center rounded border align-middle transition-colors ${
                          broken
                            ? 'border-red-500 bg-red-500/30 hover:bg-red-500/50'
                            : enabled
                              ? 'border-emerald-500 bg-emerald-500/80 hover:bg-emerald-500/60'
                              : 'border-[var(--color-edge-strong)] hover:border-emerald-500'
                        }`}
                        title={
                          broken
                            ? `链接已失效：${loc?.path}（点击卸载）`
                            : enabled
                              ? `已安装：${loc?.path}（点击卸载）`
                              : `点击安装到 ${agentLabel(agent)}（创建链接）`
                        }
                      >
                        {enabled && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                        {broken && <span className="text-[9px] font-bold text-red-300">!</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending && (() => {
        const pendingLoc = pending.skill.locations.find((l) => l.agent === pending.agent);
        // Other real agents sharing the exact same path (shared pool / external dirs).
        const sharedWith = pendingLoc
          ? [...new Set(
              pending.skill.locations
                .filter((l) => l.path === pendingLoc.path && l.agent !== pending.agent && l.agent !== 'shared-pool' && l.agent !== 'agora-store')
                .map((l) => l.agent),
            )]
          : [];
        return (
        <ConfirmDialog
          title={pending.enable ? '安装 Skill' : '卸载 Skill'}
          body={
            pending.enable ? (
              <>
                将 <span className="font-medium text-[var(--color-ink)]">{pending.skill.name}</span> 安装到{' '}
                <span className="font-medium text-[var(--color-ink)]">{agentLabel(pending.agent)}</span>
                ：在该 Agent 的 skills 目录创建指向实体文件的链接，之后该 Agent 即可使用此 skill。
              </>
            ) : (
              <>
                从 <span className="font-medium text-[var(--color-ink)]">{agentLabel(pending.agent)}</span> 卸载{' '}
                <span className="font-medium text-[var(--color-ink)]">{pending.skill.name}</span>
                ：仅移除链接，不删除实体文件。
                {sharedWith.length > 0 && (
                  <span className="mt-2 block rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                    注意：该链接位于共享目录，{sharedWith.map(agentLabel).join('、')} 也在使用同一链接。移除后这些 Agent 同样会失去此
                    skill。
                  </span>
                )}
              </>
            )
          }
          confirmLabel={pending.enable ? '安装' : '卸载'}
          danger={!pending.enable}
          busy={busy}
          onConfirm={() => void runToggle()}
          onClose={() => setPending(null)}
        />
        );
      })()}
    </div>
  );
}

// ── MCP panel ─────────────────────────────────────────────────────────────

function McpPanel({
  servers,
  writable,
  detections,
  onChanged,
  onError,
}: {
  servers: UnifiedMcpServer[];
  writable: string[];
  detections: AgentDetection[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (server: UnifiedMcpServer, agent: string, enable: boolean) => {
    const key = `${server.name}:${agent}`;
    setBusy(key);
    try {
      const r = await toolsApi.toggleMcp(server.name, agent, enable);
      onError(`${r.action}: ${r.configPath}${r.backupPath ? `（已备份 ${r.backupPath}）` : ''}`);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {servers.map((server) => (
        <div key={server.name} className="card p-4">
          <div className="mb-2 flex items-center gap-3">
            <span className="font-mono font-medium">{server.name}</span>
            <span className="text-xs text-[var(--color-ink-dim)]">{server.signature}</span>
            {server.drift && (
              <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-xs text-red-400" title="多个 Agent 中配置不一致">
                配置漂移
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {server.registrations.map((reg) => (
              <span key={reg.agent} className="flex items-center gap-1.5 rounded-lg bg-[var(--color-panel-strong)] px-2 py-1 text-xs">
                <span>{agentLabel(reg.agent)}</span>
                {detections.some((d) => d.id === reg.agent && d.mcpWritable === true) && (
                  <button
                    disabled={busy === `${server.name}:${reg.agent}`}
                    onClick={() => void toggle(server, reg.agent, false)}
                    className="text-[var(--color-ink-dim)] hover:text-red-400"
                    title="从该 Agent 配置移除（自动备份）"
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
            {writable.filter((a) => !server.registrations.some((r) => r.agent === a)).map((agent) => (
              <button
                key={agent}
                disabled={busy === `${server.name}:${agent}`}
                onClick={() => void toggle(server, agent, true)}
                className="rounded-lg border border-dashed border-[var(--color-edge-strong)] px-2 py-1 text-xs text-[var(--color-ink-dim)] hover:border-emerald-600 hover:text-emerald-400"
                title={`复制注册到 ${agentLabel(agent)}（自动备份）`}
              >
                + {agentLabel(agent)}
              </button>
            ))}
          </div>
        </div>
      ))}
      {servers.length === 0 && <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-8 text-center text-[var(--color-ink-faint)]">未发现 MCP 注册</div>}
    </div>
  );
}

// ── Registry dialog ───────────────────────────────────────────────────────

function RegistryDialog({
  writable,
  onClose,
  onInstalled,
  onError,
}: {
  /** Writable agents actually installed on this machine. */
  writable: string[];
  onClose: () => void;
  onInstalled: () => void;
  onError: (m: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [servers, setServers] = useState<RegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [agent, setAgent] = useState<string>(writable[0] ?? '');
  const [busy, setBusy] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const r = await toolsApi.registry(q);
      setServers(r.servers);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    const t = setTimeout(() => void search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  const install = async (server: RegistryServer) => {
    if (!agent) return;
    setBusy(server.name);
    try {
      await toolsApi.installMcp(agent, server);
      onError(`已安装 ${server.name} 到 ${agentLabel(agent)}`);
      onInstalled();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col card-pop p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 font-medium">MCP 市场（官方 registry）</h3>
        {writable.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-ink-faint)]">未检测到已安装且支持 MCP 配置的 Agent</div>
        ) : (
          <>
        <div className="mb-3 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 server…"
            className="flex-1 input-field"
          />
          <select value={agent} onChange={(e) => setAgent(e.target.value)} className="rounded-lg border border-[var(--color-edge-strong)] bg-[var(--color-abyss)] px-3 py-2 text-sm">
            {writable.map((a) => (
              <option key={a} value={a}>
                安装到 {agentLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {loading && <div className="py-6 text-center text-[var(--color-ink-dim)]">加载中…</div>}
          {!loading &&
            servers.map((s) => (
              <div key={s.name} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-[var(--color-panel-strong)]">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{s.name}</div>
                  {s.description && <div className="truncate text-xs text-[var(--color-ink-dim)]">{s.description}</div>}
                </div>
                <button
                  disabled={busy === s.name}
                  onClick={() => void install(s)}
                  className="ml-3 shrink-0 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === s.name ? '安装中…' : '安装'}
                </button>
              </div>
            ))}
          {!loading && servers.length === 0 && <div className="py-6 text-center text-[var(--color-ink-faint)]">无结果</div>}
        </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Health panel ──────────────────────────────────────────────────────────

function HealthPanel({ issues, onPrune }: { issues: HealthIssue[]; onPrune: () => void }) {
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button onClick={onPrune} className="btn-ghost">
          清理失效 skill 链接
        </button>
      </div>
      <div className="space-y-2">
        {issues.map((issue, i) => (
          <div
            key={i}
            className={`rounded-lg border p-3 text-sm ${
              issue.severity === 'error' ? 'border-red-900/50 bg-red-950/30' : 'border-[var(--color-edge)] bg-[var(--color-panel-strong)]/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${issue.severity === 'error' ? 'bg-red-500' : 'bg-yellow-500'}`} />
              <span>{issue.message}</span>
            </div>
            {issue.detail && <div className="mt-1 pl-4 font-mono text-xs text-[var(--color-ink-dim)]">{issue.detail}</div>}
          </div>
        ))}
        {issues.length === 0 && <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-8 text-center text-[var(--color-ink-faint)]">一切正常 ✓</div>}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export function ToolsPage() {
  const [tab, setTab] = useState<'skills' | 'mcp' | 'health'>('skills');
  const [skills, setSkills] = useState<UnifiedSkill[]>([]);
  const [servers, setServers] = useState<UnifiedMcpServer[]>([]);
  const [issues, setIssues] = useState<HealthIssue[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [statuses, setStatuses] = useState<UpdateStatus[]>([]);
  const [detections, setDetections] = useState<AgentDetection[]>([]);
  const [showRegistry, setShowRegistry] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    const [sk, mc, he, ins, ag] = await Promise.all([
      toolsApi.skills(),
      toolsApi.mcp(),
      toolsApi.health(),
      toolsApi.installed(),
      toolsApi.agents(),
    ]);
    setSkills(sk.skills);
    setServers(mc.servers);
    setIssues(he.issues);
    setInstalled(ins.installed);
    setDetections(ag.agents);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only agents actually installed on this machine get columns / action slots.
  // Linkable = installed AND the adapter declares skill dirs (drives the matrix).
  const linkableAgents = useMemo(
    () =>
      detections
        .filter((d) => d.presence === 'installed' && d.supportsSkills)
        .map((d) => d.id)
        .sort(),
    [detections],
  );
  const writableAgents = useMemo(
    () => detections.filter((d) => d.mcpWritable === true && d.installed).map((d) => d.id).sort(),
    [detections],
  );

  const runCheckUpdates = async () => {
    setCheckingUpdates(true);
    try {
      const r = await toolsApi.checkUpdates();
      setStatuses(r.statuses);
      const n = r.statuses.filter((s) => s.updateAvailable).length;
      showToast(n > 0 ? `${n} 个 skill 有更新` : '全部为最新');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">工具中心</h2>
          <nav className="flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
            {(
              [
                ['skills', `Skills (${skills.length})`],
                ['mcp', `MCP (${servers.length})`],
                ['health', `健康 (${issues.length})`],
              ] as const
            ).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)} className={tab === t ? 'nav-tab nav-tab-active' : 'nav-tab'}>
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'skills' && (
            <>
              <button
                onClick={() => void runCheckUpdates()}
                disabled={checkingUpdates}
                className="btn-ghost"
              >
                {checkingUpdates ? '检查中…' : '检查更新'}
              </button>
              <button
                onClick={() => setShowInstall(true)}
                className="btn-primary"
              >
                + 安装 Skill
              </button>
            </>
          )}
          {tab === 'mcp' && (
            <button
              onClick={() => setShowRegistry(true)}
              className="btn-primary"
            >
              浏览市场
            </button>
          )}
        </div>
      </div>

      {toast && <div className="mb-4 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel-strong)]/80 p-3 text-sm text-[var(--color-ink)]">{toast}</div>}

      {tab === 'skills' && (
        <>
          <StorePanel installed={installed} statuses={statuses} onChanged={() => void load()} onError={showToast} />
          <SkillsMatrix skills={skills} agents={linkableAgents} onChanged={() => void load()} onError={showToast} />
        </>
      )}
      {tab === 'mcp' && <McpPanel servers={servers} writable={writableAgents} detections={detections} onChanged={() => void load()} onError={showToast} />}
      {tab === 'health' && (
        <HealthPanel
          issues={issues}
          onPrune={() => {
            void toolsApi.pruneSkills().then((r) => {
              showToast(`已清理 ${r.removed.length} 个失效链接`);
              void load();
            });
          }}
        />
      )}

      {showRegistry && <RegistryDialog writable={writableAgents} onClose={() => setShowRegistry(false)} onInstalled={() => void load()} onError={showToast} />}
      {showInstall && <InstallDialog linkable={linkableAgents} onClose={() => setShowInstall(false)} onInstalled={() => void load()} onError={showToast} />}
    </div>
  );
}
