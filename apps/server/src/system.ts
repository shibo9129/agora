/**
 * Desktop OS helpers exposed to the web UI (folder picker, etc.).
 * Used when the Tauri dialog plugin is unavailable (browser / Vite).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';

const execFileAsync = promisify(execFile);

export function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function chooseFolderScript(prompt: string): string {
  return `try
POSIX path of (choose folder with prompt ${appleQuote(prompt)})
on error number -128
return ""
end try`;
}

export async function pickDirectory(prompt = '选择目录'): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('目录选择对话框目前仅支持 macOS');
  }
  const { stdout } = await execFileAsync('osascript', ['-e', chooseFolderScript(prompt)], {
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
  });
  const path = stdout.trim().replace(/\/$/, '');
  return path.length > 0 ? path : null;
}

export function systemRoutes(): Hono {
  const app = new Hono();
  app.post('/pick-directory', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 80) : '选择目录';
    try {
      const path = await pickDirectory(prompt);
      return c.json({ path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('User canceled') || message.includes('-128')) return c.json({ path: null });
      return c.json({ error: message, path: null }, 500);
    }
  });
  return app;
}
