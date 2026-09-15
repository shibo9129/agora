/**
 * Official MCP registry client (v0.1 API, frozen).
 * https://registry.modelcontextprotocol.io — read-only catalog consumption.
 */

import type { McpServerSpec, RegistryServer } from '../types.js';

const REGISTRY_BASE = process.env['AGORA_MCP_REGISTRY_URL'] ?? 'https://registry.modelcontextprotocol.io';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  at: number;
  data: RegistryServer[];
}
let cache: CacheEntry | null = null;

interface RegistryServerJson {
  name?: string;
  description?: string;
  version?: string;
  packages?: {
    registryType?: string;
    identifier?: string;
    version?: string;
    transport?: { type?: string };
  }[];
  remotes?: { type?: string; url?: string }[];
}

interface RegistryResponse {
  servers?: { server?: RegistryServerJson }[];
  metadata?: { nextCursor?: string; count?: number };
}

export async function searchRegistry(query = '', limit = 50): Promise<RegistryServer[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS && query === '') {
    return filter(cache.data, query, limit);
  }
  const url = new URL('/v0.1/servers', REGISTRY_BASE);
  url.searchParams.set('limit', String(Math.min(limit, 100)));
  if (query) url.searchParams.set('search', query);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
  const body = (await res.json()) as RegistryResponse;
  const servers: RegistryServer[] = (body.servers ?? [])
    .map((entry) => entry.server)
    .filter((s): s is RegistryServerJson => s != null && typeof s.name === 'string')
    .map((s) => {
      const out: RegistryServer = { name: s.name! };
      if (s.description) out.description = s.description;
      if (s.version) out.version = s.version;
      if (s.packages) out.packages = s.packages;
      if (s.remotes) out.remotes = s.remotes;
      return out;
    });
  if (query === '') cache = { at: Date.now(), data: servers };
  return filter(servers, query, limit);
}

function filter(servers: RegistryServer[], query: string, limit: number): RegistryServer[] {
  const q = query.toLowerCase();
  const filtered = q
    ? servers.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
    : servers;
  // The registry returns one entry per version — dedupe by name (newest first).
  const seen = new Set<string>();
  const deduped: RegistryServer[] = [];
  for (const s of filtered) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    deduped.push(s);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

/** Convert a registry entry into an installable spec (npm package or remote). */
export function registryServerToSpec(server: RegistryServer): McpServerSpec | null {
  const remote = (server.remotes as { type?: string; url?: string }[] | undefined)?.find(
    (r) => r.url && (r.type === 'streamable-http' || r.type === 'sse' || r.type === 'http'),
  );
  if (remote?.url) {
    return { type: 'remote', url: remote.url, raw: { type: 'remote', url: remote.url } };
  }
  const pkg = (server.packages as { registryType?: string; identifier?: string }[] | undefined)?.[0];
  if (pkg?.registryType === 'npm' && pkg.identifier) {
    return {
      type: 'local',
      command: ['npx', '-y', pkg.identifier],
      raw: { type: 'local', command: ['npx', '-y', pkg.identifier] },
    };
  }
  if (pkg?.registryType === 'pypi' && pkg.identifier) {
    return {
      type: 'local',
      command: ['uvx', pkg.identifier],
      raw: { type: 'local', command: ['uvx', pkg.identifier] },
    };
  }
  return null;
}
