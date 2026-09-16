import type { ReactNode } from 'react';

/** Confirmation dialog for mutating/destructive actions (explicit consent). */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onClose}>
      <div className="dialog-panel w-full max-w-sm card-pop p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 font-medium">{title}</h3>
        <div className="mb-5 text-sm leading-relaxed text-[var(--color-ink-dim)]">{body}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn-ghost">
            取消
          </button>
          <button onClick={onConfirm} disabled={busy} className={danger ? 'btn-danger-ghost' : 'btn-primary'}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
