/**
 * MCP server config scanner (read-only): parses each adapter's MCP config
 * (jsonc/json/toml/yaml) and merges registrations into a unified view with
 * drift detection. Never mutates configs; secrets are redacted in output.
 */

import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';

import { builtinAdapters, type AdapterEnv, type AgentAdapter } from '@agora/adapters';

import type { McpRegistration, McpServerSpec, UnifiedMcpServer } from '../types.js';

const MCP_KEYS = ['mcp', 'mcpServers', 'mcp_servers'] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractMcpTable(doc: unknown): Record<string, unknown> | null {
  const root = asRecord(doc);
  if (!root) return null;
  for (const key of MCP_KEYS) {
    const table = asRecord(root[key]);
    if (table) return table;
  }
  return null;
}

/** Redact secrets throughout a raw spec: URL credentials, env, headers. */
function redactRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'url' && typeof value === 'string') {
      out[key] = redactUrl(value);
    } else if ((key === 'env' || key === 'headers') && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.keys(value as Record<string, unknown>).map((k) => [k, '***']));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeSpec(name: string, raw: Record<string, unknown>): McpServerSpec {
  const spec: McpServerSpec = { raw: redactRaw(raw) };
  const type = raw['type'];
  if (type === 'local' || type === 'remote') spec.type = type;
  if (typeof raw['url'] === 'string') {
    spec.url = redactUrl(raw['url']);
    spec.type ??= 'remote';
  }
  if (Array.isArray(raw['command'])) {
    spec.command = (raw['command'] as unknown[]).filter((x): x is string => typeof x === 'string');
    spec.type ??= 'local';
  } else if (typeof raw['command'] === 'string') {
    const args = Array.isArray(raw['args']) ? (raw['args'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    spec.command = [raw['command'], ...args];
    spec.type ??= 'local';
  }
  if (typeof raw['enabled'] === 'boolean') spec.enabled = raw['enabled'];
  else if (typeof raw['disabled'] === 'boolean') spec.enabled = !raw['disabled'];
  void name;
  return spec;
}

/** Redact credentials in a URL (query tokens, userinfo) for display/signatures. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|auth|password|credential/i.test(key)) {
        u.searchParams.set(key, '***');
      }
    }
    return u.toString();
  } catch {
    return url.replace(/([?&][^=]*?(?:token|key|secret|auth)[^=]*?=)[^&]*/gi, '$1***');
  }
}

function signatureOf(spec: McpServerSpec): string {
  if (spec.url) return `url:${redactUrl(spec.url)}`;
  if (spec.command) return `cmd:${spec.command.join(' ')}`;
  return 'unknown';
}

export async function scanMcpRegistrations(
  adapter: AgentAdapter,
  env?: AdapterEnv,
): Promise<McpRegistration[]> {
  if (!adapter.mcpConfig) return [];
  const ref = adapter.mcpConfig(env);
  if (!ref) return [];
  let text: string;
  try {
    text = await readFile(ref.path, 'utf-8');
  } catch {
    return [];
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
    return [];
  }
  const table = extractMcpTable(doc);
  if (!table) return [];
  const out: McpRegistration[] = [];
  for (const [name, rawValue] of Object.entries(table)) {
    const raw = asRecord(rawValue);
    if (!raw) continue;
    out.push({ agent: adapter.id, configPath: ref.path, serverName: name, spec: normalizeSpec(name, raw) });
  }
  return out;
}

export async function scanUnifiedMcpServers(
  env?: AdapterEnv,
  adapters: AgentAdapter[] = builtinAdapters,
): Promise<UnifiedMcpServer[]> {
  const perAgent = await Promise.all(adapters.map((a) => scanMcpRegistrations(a, env)));
  const byName = new Map<string, UnifiedMcpServer>();
  for (const regs of perAgent) {
    for (const reg of regs) {
      let server = byName.get(reg.serverName);
      if (!server) {
        server = {
          name: reg.serverName,
          registrations: [],
          signature: signatureOf(reg.spec),
          drift: false,
        };
        byName.set(reg.serverName, server);
      }
      server.registrations.push(reg);
      if (signatureOf(reg.spec) !== server.signature) server.drift = true;
    }
  }
  for (const server of byName.values()) {
    server.registrations.sort((a, b) => a.agent.localeCompare(b.agent));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
