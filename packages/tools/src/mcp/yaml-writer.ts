/**
 * YAML config writer: line-level block surgery for the top-level
 * `mcp_servers:` mapping (Hermes config.yaml). A full parse+stringify
 * round-trip would destroy comments and key order, so we locate line spans
 * and edit text ranges only. Single-entry serialization delegates to the
 * `yaml` package (nested maps like headers/sampling are preserved).
 */

import { stringify } from 'yaml';

import type { McpServerSpec } from '../types.js';

function formatKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** Serialize one server entry (`  name:` + 4-space-indented fields). */
export function serializeYamlEntry(serverName: string, spec: McpServerSpec): string {
  const value: Record<string, unknown> = { ...spec.raw };
  delete value['name'];
  delete value['args'];
  if (spec.command && spec.command.length > 0) {
    value['command'] = spec.command[0];
    if (spec.command.length > 1) value['args'] = spec.command.slice(1);
  }
  if (spec.url) value['url'] = spec.url;
  if (spec.type) value['type'] = spec.type;
  if (spec.enabled !== undefined) value['enabled'] = spec.enabled;
  const body = stringify(value)
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  return `  ${formatKey(serverName)}:\n${body}\n`;
}

interface BlockSpan {
  start: number;
  end: number;
}

/** Top-level `mcp_servers:` block: ends at the next non-indented key or EOF. */
function findServersBlock(lines: string[]): BlockSpan | null {
  for (let i = 0; i < lines.length; i++) {
    if (/^mcp_servers\s*:/.test(lines[i]!)) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
        if (!/^[ \t]/.test(line)) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

/** Entry inside the block: exactly 2-space-indented `name:` line. */
function findEntry(lines: string[], block: BlockSpan, serverName: string): BlockSpan | null {
  const entryRe = (name: string): RegExp => new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const quotedRe = (name: string): RegExp => new RegExp(`^  ${JSON.stringify(name)}\\s*:`);
  for (let i = block.start + 1; i < block.end; i++) {
    const line = lines[i]!;
    if (entryRe(serverName).test(line) || quotedRe(serverName).test(line)) {
      let end = block.end;
      for (let j = i + 1; j < block.end; j++) {
        const next = lines[j]!;
        if (next.trim() === '') continue;
        // Entry ends at the next 2-space (or less) indented key.
        if (/^ {0,2}\S/.test(next)) {
          end = j;
          break;
        }
      }
      return { start: i, end };
    }
  }
  return null;
}

export function setYamlMcpServer(text: string, serverName: string, spec: McpServerSpec | null): string {
  const lines = text.split('\n');
  const block = findServersBlock(lines);

  if (!block) {
    if (spec === null) return text;
    // No mcp_servers block at all — append one at EOF.
    const needsBlank = lines.length > 0 && lines[lines.length - 1]!.trim() !== '';
    const blockText = `mcp_servers:\n${serializeYamlEntry(serverName, spec)}`;
    return text + (needsBlank ? '\n' : '') + blockText;
  }

  const entry = findEntry(lines, block, serverName);
  if (spec === null) {
    if (!entry) return text;
    lines.splice(entry.start, entry.end - entry.start);
    return lines.join('\n');
  }

  const entryText = serializeYamlEntry(serverName, spec);
  const entryLines = entryText.trimEnd().split('\n');
  if (entry) {
    lines.splice(entry.start, entry.end - entry.start, ...entryLines);
  } else {
    lines.splice(block.end, 0, ...entryLines);
  }
  return lines.join('\n');
}
