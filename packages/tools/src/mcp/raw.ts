/**
 * Raw (unredacted) spec reader for the toggle/copy path. Scan output is
 * redacted for display; writing a registration from one agent into another
 * requires the original values, re-read from the source config on demand.
 * Never exposed over the API.
 */

import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import type { McpServerSpec } from '../types.js';

const MCP_KEYS = ['mcp', 'mcpServers', 'mcp_servers'] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function readMcpServerSpecRaw(
  agentId: string,
  serverName: string,
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<McpServerSpec | null> {
  const adapter = adapters.find((a) => a.id === agentId);
  const ref = adapter?.mcpConfig?.(env);
  if (!adapter || !ref) return null;
  let text: string;
  try {
    text = await readFile(ref.path, 'utf-8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    switch (ref.format) {
      case 'jsonc':
      case 'json':
        doc = parseJsonc(text);
        break;
      case 'toml':
        doc = parseToml(text);
        break;
      case 'yaml':
        doc = parseYaml(text);
        break;
    }
  } catch {
    return null;
  }
  const root = asRecord(doc);
  if (!root) return null;
  for (const key of MCP_KEYS) {
    const table = asRecord(root[key]);
    const raw = table ? asRecord(table[serverName]) : null;
    if (raw) {
      const spec: McpServerSpec = { raw };
      const type = raw['type'];
      if (type === 'local' || type === 'remote') spec.type = type;
      if (typeof raw['url'] === 'string') {
        spec.url = raw['url'];
        spec.type ??= 'remote';
      }
      if (Array.isArray(raw['command'])) {
        spec.command = (raw['command'] as unknown[]).filter((x): x is string => typeof x === 'string');
        spec.type ??= 'local';
      } else if (typeof raw['command'] === 'string') {
        const args = Array.isArray(raw['args'])
          ? (raw['args'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        spec.command = [raw['command'], ...args];
        spec.type ??= 'local';
      }
      if (typeof raw['enabled'] === 'boolean') spec.enabled = raw['enabled'];
      else if (typeof raw['disabled'] === 'boolean') spec.enabled = !raw['disabled'];
      return spec;
    }
  }
  return null;
}
