/**
 * TOML config writer: line-level section surgery for `[mcp_servers.<name>]`
 * tables. A full parse+stringify round-trip would destroy the user's
 * formatting/comments (Codex config.toml files are hand-maintained), so we
 * locate the section's line span and replace/delete/insert text ranges only.
 */

import type { McpServerSpec } from '../types.js';

function escapeTomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}

function escapeTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Serialize a server spec into a `[mcp_servers.<name>]` section block. */
export function serializeTomlSection(serverName: string, spec: McpServerSpec): string {
  const lines: string[] = [`[mcp_servers.${escapeTomlKey(serverName)}]`];
  if (spec.command && spec.command.length > 0) {
    const [cmd, ...args] = spec.command;
    lines.push(`command = ${escapeTomlString(cmd!)}`);
    if (args.length > 0) {
      lines.push(`args = [${args.map(escapeTomlString).join(', ')}]`);
    }
  }
  if (spec.url) lines.push(`url = ${escapeTomlString(spec.url)}`);
  if (spec.enabled === false) lines.push(`disabled = true`);
  // Preserve vendor extras that we don't manage explicitly.
  for (const [key, value] of Object.entries(spec.raw)) {
    if (['command', 'args', 'url', 'type', 'enabled', 'disabled', 'name'].includes(key)) continue;
    if (typeof value === 'string') lines.push(`${key} = ${escapeTomlString(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key} = ${value}`);
  }
  const env = spec.raw['env'] ?? spec.raw['environment'];
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const pairs = Object.entries(env).filter(([,v]) => typeof v === 'string').map(([k,v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    if (pairs.length) lines.push(`env = { ${pairs.join(', ')} }`);
  }
  return lines.join('\n') + '\n';
}

interface SectionSpan {
  start: number; // line index of the section header
  end: number; // line index one past the last line of the section
}

function findSection(lines: string[], serverName: string): SectionSpan | null {
  const headerRe = /^\s*\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\s*\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headerRe);
    if (!m) continue;
    const rawName = m[1]!;
    const name = rawName.startsWith('"') ? rawName.slice(1, -1).replace(/\\"/g, '"') : rawName;
    if (name !== serverName) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

/** Insert position: just before the first non-mcp_servers top-level section
 *  after the last mcp_servers section, or EOF. Keeps MCP sections clustered. */
function findInsertPosition(lines: string[]): number {
  let lastMcpEnd = -1;
  const headerRe = /^\s*\[/;
  const mcpRe = /^\s*\[\s*mcp_servers\./;
  for (let i = 0; i < lines.length; i++) {
    if (mcpRe.test(lines[i]!)) {
      lastMcpEnd = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (headerRe.test(lines[j]!)) break;
        lastMcpEnd = j + 1;
      }
    }
  }
  return lastMcpEnd === -1 ? lines.length : lastMcpEnd;
}

export function setTomlMcpServer(text: string, serverName: string, spec: McpServerSpec | null): string {
  const lines = text.split('\n');
  const span = findSection(lines, serverName);
  if (spec === null) {
    if (!span) return text;
    lines.splice(span.start, span.end - span.start);
    return lines.join('\n');
  }
  const block = serializeTomlSection(serverName, spec);
  if (span) {
    lines.splice(span.start, span.end - span.start, ...block.trimEnd().split('\n'));
    return lines.join('\n');
  }
  const pos = findInsertPosition(lines);
  // Ensure a blank line separates from the previous block.
  const blockLines = block.trimEnd().split('\n');
  const needsLeadingBlank = pos > 0 && lines[pos - 1]?.trim() !== '';
  lines.splice(pos, 0, ...(needsLeadingBlank ? ['', ...blockLines] : blockLines));
  return lines.join('\n');
}
