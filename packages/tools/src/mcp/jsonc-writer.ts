/**
 * JSONC config writer: comment-preserving edits via jsonc-parser.
 * The target table is detected among known MCP keys and created if absent.
 */

import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import type { McpServerSpec } from '../types.js';

const JSON_MCP_KEYS = ['mcp', 'mcpServers', 'mcp_servers'] as const;

function detectKey(doc: unknown, preferred: string): string {
  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const key of JSON_MCP_KEYS) {
      if (key in (doc as Record<string, unknown>)) return key;
    }
  }
  return preferred;
}

/** Serialize a spec into the shape opencode-style jsonc configs use. */
function specToJson(spec: McpServerSpec, key: string): Record<string, unknown> {
  // Preserve vendor extras, then overlay normalized fields.
  const out: Record<string, unknown> = { ...spec.raw };
  delete out['args']; // args are merged into command[]
  if (spec.type) out['type'] = spec.type;
  if (spec.command) out['command'] = spec.command;
  if (spec.url) out['url'] = spec.url;
  if (spec.enabled !== undefined) out['enabled'] = spec.enabled;
  if (key !== 'mcp') {
    delete out['type'];
    delete out['enabled'];
    if (spec.command) { out['command'] = spec.command[0]; out['args'] = spec.command.slice(1); }
    if (out['environment']) { out['env'] = out['environment']; delete out['environment']; }
  } else if (out['env']) { out['environment'] = out['env']; delete out['env']; }
  return out;
}

export function setJsoncMcpServer(
  text: string,
  serverName: string,
  spec: McpServerSpec | null,
  preferredKey = 'mcp',
): string {
  const doc = parseJsonc(text);
  const key = detectKey(doc, preferredKey);
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: '\n' as const };
  const tableExists =
    doc !== null && typeof doc === 'object' && !Array.isArray(doc) && key in (doc as Record<string, unknown>);

  if (spec === null) {
    if (!tableExists) return text;
    const edits = modify(text, [key, serverName], undefined, { formattingOptions });
    return applyEdits(text, edits);
  }
  if (!tableExists) {
    // Create the table with the first entry in one edit.
    const edits = modify(text, [key], { [serverName]: specToJson(spec, key) }, { formattingOptions });
    return applyEdits(text, edits);
  }
  // In-place entry edit: sibling entries and their comments are untouched.
  const edits = modify(text, [key, serverName], specToJson(spec, key), { formattingOptions });
  return applyEdits(text, edits);
}
