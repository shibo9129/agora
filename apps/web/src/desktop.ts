/** Desktop-shell helpers. No-ops in the browser / Vite dev server. */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch {
    // Permission missing or not a desktop window — ignore.
  }
}

export function onWindowDragMouseDown(e: { button: number; target: EventTarget | null }): void {
  if (e.button !== 0) return;
  const t = e.target;
  if (t instanceof Element && t.closest('button, a, input, textarea, select, [role="button"]')) return;
  void startWindowDrag();
}

/** Native folder picker (Finder on macOS). Returns null if the user cancels. */
export async function pickDirectory(title = '选择目录'): Promise<string | null> {
  if (isTauri()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false, title });
      if (typeof selected === 'string' && selected.trim().length > 0) return selected;
      if (selected === null) return null;
    } catch {
      // Fall through to the sidecar osascript picker.
    }
  }
  const res = await fetch('/api/system/pick-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agora-Request': '1' },
    body: JSON.stringify({ prompt: title }),
  });
  const text = await res.text();
  let body: { path?: string | null; error?: string };
  try {
    body = JSON.parse(text) as { path?: string | null; error?: string };
  } catch {
    throw new Error(res.ok ? '选择目录失败：无效响应' : `选择目录失败：${res.status}`);
  }
  if (!res.ok) throw new Error(body.error ?? `选择目录失败：${res.status}`);
  const path = body.path?.trim();
  return path ? path : null;
}
