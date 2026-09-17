/**
 * Agora hub MCP server (stdio transport).
 *
 * Exposes the hub's runtime surface to enrolled agents:
 *   memory_search / memory_read / memory_write  — shared cross-agent memory
 *   kb_list / kb_search                          — registered knowledge bases
 *
 * Progressive disclosure: search tools return compact L0 rows; full content
 * is fetched on demand with read tools (token-frugal by design).
 *
 * Run: npx tsx <this file>  (agents get this command via `agora enroll`)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { listKbs, migrateKnowledge, searchKb } from '@agora/knowledge';
import { MemoryStore, defaultMemoryRoot } from '@agora/memory';
import { openDb } from '@agora/usage';

const db = openDb();
migrateKnowledge(db);
const memory = new MemoryStore(db, defaultMemoryRoot());

// Injected at bundle time (scripts/bundle.mjs define) — never hardcode a version here.
declare const __AGORA_VERSION__: string | undefined;

const server = new McpServer({
  name: 'agora-hub',
  version: typeof __AGORA_VERSION__ !== 'undefined' ? __AGORA_VERSION__ : '0.0.0-dev',
});

function text(content: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: content }] };
}

// ── memory_search ─────────────────────────────────────────────────────────
server.tool(
  'memory_search',
  'Search the shared cross-agent memory. Returns compact rows (path + one-line abstract). Call memory_read with a path to expand the full entry.',
  {
    query: z.string().describe('Search query (name/abstract/body, CJK ok, ≥3 chars best)'),
    scope: z.string().optional().describe("Filter by scope, e.g. 'global' or 'project-<slug>'"),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
  },
  async ({ query, scope, limit }) => {
    const opts: { scope?: never; limit?: number } = {};
    if (scope !== undefined) opts.scope = scope as never;
    if (limit !== undefined) opts.limit = limit;
    const hits = memory.search(query, opts);
    if (hits.length === 0) return text('（无匹配记忆）');
    const lines = hits.map((h) => `- \`${h.path}\` — ${h.abstract || h.name}  [${h.type}${h.by ? `, by ${h.by}` : ''}]`);
    return text(lines.join('\n'));
  },
);

// ── memory_read ───────────────────────────────────────────────────────────
server.tool(
  'memory_read',
  'Read the full memory entry at a path returned by memory_search.',
  { path: z.string().describe("Memory path, e.g. 'global/decisions/agora-mcp-shape.md'") },
  async ({ path }) => {
    const doc = await memory.read(path);
    if (!doc) return text(`（记忆不存在: ${path}）`);
    return text(`# ${doc.name}\n\n> ${doc.abstract}\n\n${doc.body}\n\n---\nrevision: ${doc.revision}\nupdated: ${doc.updatedAt}${doc.by ? ` by ${doc.by}` : ''}`);
  },
);

// ── memory_write ──────────────────────────────────────────────────────────
server.tool(
  'memory_write',
  'Write a memory entry (creates or updates). Keep abstract to one line; write search-friendly keywords. Never store secrets/credentials.',
  {
    expectedUpdatedAt: z.string().optional().describe('Optional timestamp check'),
    expectedRevision: z.string().optional().describe('Required when updating an existing entry; use revision from memory_read'),
    name: z.string().describe('Entry name (used as the file name, keep it slug-like)'),
    abstract: z.string().describe('One-line abstract shown in search results'),
    body: z.string().describe('Full markdown body'),
    scope: z.string().optional().describe("'global' (default) or 'project-<slug>'"),
    group: z.string().optional().describe("Group folder, e.g. 'decisions' | 'facts' | 'preferences' (default 'notes')"),
    type: z.string().optional().describe("Type tag, e.g. 'decision' | 'fact' | 'preference' | 'note'"),
    by: z.string().optional().describe('Author agent id (e.g. codex, opencode)'),
  },
  async (input) => {
    const entry = await memory.write({
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(input.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      name: input.name,
      abstract: input.abstract,
      body: input.body,
      ...(input.scope !== undefined ? { scope: input.scope as never } : {}),
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
    });
    return text(`已写入记忆 \`${entry.path}\``);
  },
);

// ── kb_list ───────────────────────────────────────────────────────────────
server.tool('kb_list', 'List registered knowledge bases (name, root path, size).', {}, async () => {
  const kbs = listKbs(db);
  if (kbs.length === 0) return text('（尚未注册知识库）');
  return text(kbs.map((k) => `- **${k.name}** (${k.id}) — ${k.rootPath} · ${k.fileCount} 文件`).join('\n'));
});

// ── kb_search ─────────────────────────────────────────────────────────────
server.tool(
  'kb_search',
  'Search file/dir names inside a registered knowledge base. Returns relative paths; ask the user/hub for file contents.',
  {
    kb: z.string().describe('Knowledge base id or exact name'),
    query: z.string().describe('Name query (≥3 chars works best)'),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ kb, query, limit }) => {
    const kbs = listKbs(db);
    const target = kbs.find((k) => k.id === kb || k.name === kb);
    if (!target) return text(`（知识库不存在: ${kb}，先用 kb_list 查看）`);
    const hits = searchKb(db, target.id, query, limit ?? 20);
    if (hits.length === 0) return text('（无匹配）');
    return text(hits.map((h) => `- ${h.kind === 'dir' ? '📁' : '📄'} \`${h.path}\``).join('\n'));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
