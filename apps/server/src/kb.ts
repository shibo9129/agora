/**
 * Knowledge base routes. All fs-touching endpoints resolve the requested
 * relative path and verify containment inside the kb root before acting.
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve, sep } from 'node:path';

import {
  safeKbPath,
  builtinTemplates,
  createKb,
  deleteKb,
  executeMoves,
  getKb,
  getKbByPath,
  getTemplate,
  listKbs,
  listUndoRecords,
  markScanned,
  proposeOrganization,
  queryTreemap,
  scaffoldTemplate,
  scanKb,
  searchKb,
  undoMoves,
  type OrganizeMove,
} from '@agora/knowledge';

function openInFileManager(absPath: string): Promise<void> {
  const os = platform();
  const cmd = os === 'darwin' ? 'open' : os === 'win32' ? 'explorer' : 'xdg-open';
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, [absPath], (err) => (err ? rejectPromise(err) : resolvePromise()));
  });
}

export function kbRoutes(db: Database.Database): Hono {
  const app = new Hono();

  app.get('/templates', (c) => c.json({ templates: builtinTemplates }));

  app.get('/', (c) => c.json({ kbs: listKbs(db) }));

  // Register an existing directory as a kb.
  app.post('/', async (c) => {
    const body = await c.req.json<{ name?: string; rootPath?: string }>();
    if (!body.name?.trim() || !body.rootPath?.trim()) {
      return c.json({ error: 'name 和 rootPath 必填' }, 400);
    }
    const rootPath = resolve(body.rootPath.trim());
    if (!existsSync(rootPath)) return c.json({ error: `目录不存在: ${rootPath}` }, 400);
    if (getKbByPath(db, rootPath)) return c.json({ error: '该目录已注册' }, 409);
    const kb = createKb(db, body.name.trim(), rootPath);
    const scan = await scanKb(db, kb.id, rootPath);
    markScanned(db, kb.id);
    return c.json({ kb, scan }, 201);
  });

  // Create a brand-new kb from a template.
  app.post('/create', async (c) => {
    const body = await c.req.json<{ name?: string; rootPath?: string; templateId?: string }>();
    if (!body.name?.trim() || !body.rootPath?.trim() || !body.templateId) {
      return c.json({ error: 'name、rootPath、templateId 必填' }, 400);
    }
    const template = getTemplate(body.templateId);
    if (!template) return c.json({ error: `未知模板: ${body.templateId}` }, 400);
    const rootPath = resolve(body.rootPath.trim());
    if (existsSync(rootPath)) {
      // Allow scaffolding into an existing EMPTY dir only.
      const { readdirSync } = await import('node:fs');
      if (readdirSync(rootPath).length > 0) return c.json({ error: '目标目录已存在且非空' }, 409);
    } else {
      await mkdir(rootPath, { recursive: true });
    }
    await scaffoldTemplate(rootPath, template);
    const kb = createKb(db, body.name.trim(), rootPath, template.id);
    const scan = await scanKb(db, kb.id, rootPath);
    markScanned(db, kb.id);
    return c.json({ kb, scan }, 201);
  });

  function requireKb(id: string) {
    return getKb(db, id);
  }

  app.delete('/:id', (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    deleteKb(db, kb.id); // index only — never touches the on-disk directory
    return c.json({ ok: true });
  });

  app.post('/:id/scan', async (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const scan = await scanKb(db, kb.id, kb.rootPath);
    markScanned(db, kb.id);
    return c.json(scan);
  });

  app.get('/:id/treemap', (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const path = c.req.query('path') ?? '';
    const depth = Number(c.req.query('depth') ?? 4);
    const tm = queryTreemap(db, kb.id, path, Number.isFinite(depth) ? depth : 4);
    if (!tm) return c.json({ error: '路径未索引，请先扫描' }, 404);
    return c.json(tm);
  });

  // Direct children of a path (sidebar tree / file list).
  app.get('/:id/entries', (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const path = c.req.query('path') ?? '';
    const prefixDepth = path === '' ? 0 : path.split('/').length;
    const rows = db
      .prepare(
        `SELECT path, name, kind, size, depth, ext FROM kb_entries
          WHERE kb_id = ? AND depth = ? AND path != ''
            AND (? = '' OR substr(path, 1, length(?) + 1) = ? || '/')
          ORDER BY kind DESC, name COLLATE NOCASE`,
      )
      .all(kb.id, prefixDepth + 1, path, path, path);
    return c.json({ entries: rows });
  });

  app.get('/:id/search', (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    return c.json({ hits: searchKb(db, kb.id, c.req.query('q') ?? '') });
  });

  // Open a file/dir in the OS file manager (Finder on macOS).
  app.post('/:id/open', async (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const body = await c.req.json<{ path?: string }>();
    const rel = body.path ?? '';
    const abs = await safeKbPath(kb.rootPath, rel).catch(() => null);
    if (!abs) return c.json({ error: '路径越界' }, 400);
    if (!existsSync(abs)) return c.json({ error: '路径不存在' }, 404);
    await openInFileManager(abs);
    return c.json({ ok: true });
  });

  // ── Organize ────────────────────────────────────────────────────────────
  app.post('/:id/organize/propose', async (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const body = await c.req.json<{ subdir?: string }>().catch(() => ({}) as { subdir?: string });
    return c.json(proposeOrganization(db, kb.id, body.subdir ?? ''));
  });

  app.post('/:id/organize/execute', async (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const body = await c.req.json<{ moves?: OrganizeMove[] }>();
    if (!Array.isArray(body.moves)) return c.json({ error: 'moves 必填' }, 400);
    const result = await executeMoves(db, kb.id, kb.rootPath, body.moves);
    await scanKb(db, kb.id, kb.rootPath);
    markScanned(db, kb.id);
    return c.json(result);
  });

  app.get('/:id/undo', (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    return c.json({ records: listUndoRecords(db, kb.id) });
  });

  app.post('/:id/organize/undo', async (c) => {
    const kb = requireKb(c.req.param('id'));
    if (!kb) return c.json({ error: 'kb 不存在' }, 404);
    const body = await c.req.json<{ undoId?: number }>();
    const record = listUndoRecords(db, kb.id).find((r) => r.id === body.undoId);
    if (!record || record.undoneAt) return c.json({ error: 'undo 记录不存在' }, 404);
    const result = await undoMoves(db, kb.rootPath, record.id, record.moves);
    await scanKb(db, kb.id, kb.rootPath);
    markScanned(db, kb.id);
    return c.json(result);
  });

  return app;
}
