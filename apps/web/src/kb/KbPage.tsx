import { useEffect, useMemo, useState } from 'react';
import { formatBytes, kbApi, type KnowledgeBase, type KbTemplate } from './api';
import { ConfirmDialog } from '../components/ConfirmDialog';

function CreateDialog({
  templates,
  onClose,
  onCreated,
}: {
  templates: KbTemplate[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<'create' | 'register'>('create');
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create') await kbApi.create(name, rootPath, templateId);
      else await kbApi.register(name, rootPath);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md card-pop p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex gap-0.5 rounded-xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-1">
          {(
            [
              ['create', '从模板新建'],
              ['register', '注册已有目录'],
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

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-[var(--color-ink-dim)]">知识库名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：产品知识库"
            className="w-full input-field"
          />
        </label>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-[var(--color-ink-dim)]">{mode === 'create' ? '创建到目录' : '已有目录路径'}</span>
          <input
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder={mode === 'create' ? '/Users/you/wiki/my-kb' : '/Users/you/notes'}
            className="w-full input-field font-mono text-xs"
          />
        </label>

        {mode === 'create' && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-[var(--color-ink-dim)]">模板</span>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full input-field"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-[var(--color-ink-dim)]">
              {templates.find((t) => t.id === templateId)?.description}
            </span>
          </label>
        )}

        {error && <div className="mb-3 rounded-lg bg-red-950/50 p-2 text-xs text-red-300">{error}</div>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || !rootPath.trim()}
            className="btn-primary"
          >
            {busy ? '处理中…' : mode === 'create' ? '创建' : '注册'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function KbPage({ onOpenKb }: { onOpenKb: (kb: KnowledgeBase) => void }) {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [templates, setTemplates] = useState<KbTemplate[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<KnowledgeBase | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = async () => {
    try {
      const [l, t] = await Promise.all([kbApi.list(), kbApi.templates()]);
      setKbs(l.kbs);
      setTemplates(t.templates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const cards = useMemo(() => kbs, [kbs]);

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      await kbApi.remove(pendingRemove.id);
      setPendingRemove(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingRemove(null);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">知识库</h2>
          <p className="text-sm text-[var(--color-ink-dim)]">注册或新建目录，透视结构、搜索、整理</p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="btn-primary"
        >
          + 新建 / 注册
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-950/50 p-3 text-sm text-red-300">{error}</div>}

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-edge-strong)] p-12 text-center text-[var(--color-ink-faint)]">
          还没有知识库 — 点击右上角「新建 / 注册」开始
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((kb) => (
            <div
              key={kb.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenKb(kb)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenKb(kb);
                }
              }}
              className="card cursor-pointer p-4 text-left transition-colors hover:border-[var(--color-edge-strong)]"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">{kb.name}</span>
                <span className="flex items-center gap-1.5">
                  {kb.template && <span className="rounded bg-[var(--color-panel-strong)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-dim)]">{kb.template}</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingRemove(kb);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="rounded-md px-1.5 py-0.5 text-xs text-[var(--color-ink-faint)] hover:text-red-400"
                    title="移除注册（不删除本地文件）"
                    aria-label={`移除 ${kb.name} 的注册`}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <div className="mb-3 truncate font-mono text-xs text-[var(--color-ink-dim)]" title={kb.rootPath}>
                {kb.rootPath}
              </div>
              <div className="flex gap-4 text-xs text-[var(--color-ink-dim)]">
                <span>{formatBytes(kb.totalBytes)}</span>
                <span>{kb.fileCount} 文件</span>
                <span>{kb.dirCount} 目录</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showDialog && <CreateDialog templates={templates} onClose={() => setShowDialog(false)} onCreated={() => void load()} />}

      {pendingRemove && (
        <ConfirmDialog
          title="移除知识库注册"
          body={
            <>
              仅从 Agora 移除 <span className="font-medium text-[var(--color-ink)]">{pendingRemove.name}</span> 的注册与索引。
              <br />
              本地目录 <span className="font-mono text-xs text-[var(--color-ink)]">{pendingRemove.rootPath}</span>{' '}
              及其全部文件<strong>不会被删除</strong>，之后可随时重新注册。
            </>
          }
          confirmLabel="移除注册"
          danger
          busy={removing}
          onConfirm={() => void confirmRemove()}
          onClose={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}
