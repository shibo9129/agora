/**
 * Tool center routes: unified skills/MCP views, toggle matrices, registry
 * catalog, health checks. Writes go through backup+atomic-replace paths in
 * @agora/tools; raw (unredacted) specs never leave this process.
 */
import { builtinAdapters } from '@agora/adapters';
import { Hono } from 'hono';

import {
  checkUpdates,
  installSkill,
  listBrokenSkillLinks,
  listInstalled,
  pruneBrokenSkillLinks,
  readMcpServerSpecRaw,
  registryServerToSpec,
  runHealthChecks,
  scanUnifiedMcpServers,
  scanUnifiedSkills,
  searchRegistry,
  setMcpServerForAgent,
  setSkillEnabled,
  uninstallSkill,
  updateSkill,
  type McpWriteResult,
  type RegistryServer,
  type SkillSource,
} from '@agora/tools';

export function toolRoutes(): Hono {
  const app = new Hono();

  // ── Skills ──────────────────────────────────────────────────────────────
  app.get('/skills', async (c) => {
    const skills = await scanUnifiedSkills();
    return c.json({ skills });
  });

  app.post('/skills/:name/toggle', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json<{ agent?: string; enable?: boolean }>();
    if (!body.agent || typeof body.enable !== 'boolean') {
      return c.json({ error: 'agent 和 enable 必填' }, 400);
    }
    try {
      const result = await setSkillEnabled(name, body.agent, body.enable);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Dry run first: the UI shows this list in the confirm dialog so "清理"
  // stops being a leap of faith.
  app.get('/skills/broken-links', async (c) => c.json({ links: await listBrokenSkillLinks() }));
  app.post('/skills/prune', async (c) => c.json(await pruneBrokenSkillLinks()));

  // ── Central store: install / update / uninstall ─────────────────────────
  app.get('/skills/installed', async (c) => {
    const installed = await listInstalled();
    return c.json({ installed });
  });

  app.post('/skills/install', async (c) => {
    const body = await c.req.json<{ source?: SkillSource; linkTo?: string[] }>();
    if (!body.source?.type) return c.json({ error: 'source 必填' }, 400);
    try {
      const result = await installSkill(body.source, { linkTo: body.linkTo ?? [] });
      return c.json(result, result.installed.length > 0 ? 201 : 400);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/skills/check-updates', async (c) => c.json({ statuses: await checkUpdates() }));

  app.post('/skills/update', async (c) => {
    const body = await c.req.json<{ name?: string }>();
    if (!body.name) return c.json({ error: 'name 必填' }, 400);
    try {
      return c.json(await updateSkill(body.name));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/skills/uninstall', async (c) => {
    const body = await c.req.json<{ name?: string }>();
    if (!body.name) return c.json({ error: 'name 必填' }, 400);
    try {
      return c.json(await uninstallSkill(body.name));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── MCP servers ─────────────────────────────────────────────────────────
  app.get('/mcp', async (c) => {
    const servers = await scanUnifiedMcpServers();
    return c.json({ servers });
  });

  // Enable: copy this server's registration into another agent (raw spec is
  // re-read from an existing registration inside this process, never from
  // the redacted API payload). Disable: remove from the agent's config.
  app.post('/mcp/:name/toggle', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json<{ agent?: string; enable?: boolean }>();
    if (!body.agent || typeof body.enable !== 'boolean') {
      return c.json({ error: 'agent 和 enable 必填' }, 400);
    }
    try {
      if (!body.enable) {
        const result = await setMcpServerForAgent(body.agent, name, null);
        return c.json(result);
      }
      const unified = await scanUnifiedMcpServers();
      const server = unified.find((s) => s.name === name);
      if (!server) return c.json({ error: `未知 MCP server: ${name}` }, 404);
      const source = server.registrations.find((r) => r.agent !== body.agent) ?? server.registrations[0];
      if (!source) return c.json({ error: '没有可复制的现有注册' }, 400);
      const rawSpec = await readMcpServerSpecRaw(source.agent, name);
      if (!rawSpec) return c.json({ error: `无法从 ${source.agent} 读取原始配置` }, 400);
      const result = await setMcpServerForAgent(body.agent, name, rawSpec);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Unify: rewrite every drifting registration of this server to match one
  // chosen agent's config. The raw spec is re-read inside this process, so the
  // secrets the API redacts are carried over intact; each write backs up first.
  app.post('/mcp/:name/unify', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json<{ sourceAgent?: string }>();
    if (!body.sourceAgent) return c.json({ error: 'sourceAgent 必填' }, 400);
    try {
      const unified = await scanUnifiedMcpServers();
      const server = unified.find((s) => s.name === name);
      if (!server) return c.json({ error: `未知 MCP server: ${name}` }, 404);
      const source = server.registrations.find((r) => r.agent === body.sourceAgent);
      if (!source) return c.json({ error: `${body.sourceAgent} 没有 ${name} 的注册` }, 400);
      const rawSpec = await readMcpServerSpecRaw(source.agent, name);
      if (!rawSpec) return c.json({ error: `无法从 ${source.agent} 读取原始配置` }, 400);

      const writable = new Set(
        (await Promise.all(builtinAdapters.map(async (a) => ((await a.detect()).installed && a.mcpWritable === true ? a.id : null))))
          .filter((id): id is string => id !== null),
      );
      const updated: McpWriteResult[] = [];
      const skipped: { agent: string; reason: string }[] = [];
      for (const reg of server.registrations) {
        if (reg.agent === source.agent) continue;
        if (reg.signature === source.signature) continue;
        if (!writable.has(reg.agent)) {
          skipped.push({ agent: reg.agent, reason: 'Agora 无法写入该 Agent 的配置' });
          continue;
        }
        try {
          const r = await setMcpServerForAgent(reg.agent, name, rawSpec);
          updated.push(r);
        } catch (err) {
          skipped.push({ agent: reg.agent, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return c.json({ server: name, sourceAgent: source.agent, signature: source.signature, updated, skipped });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Registry catalog ────────────────────────────────────────────────────
  app.get('/mcp/registry', async (c) => {
    try {
      const servers = await searchRegistry(c.req.query('q') ?? '');
      return c.json({ servers });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post('/mcp/install', async (c) => {
    const body = await c.req.json<{ agent?: string; server?: RegistryServer }>();
    if (!body.agent || !body.server?.name) return c.json({ error: 'agent 和 server 必填' }, 400);
    const spec = registryServerToSpec(body.server);
    if (!spec) return c.json({ error: '该 registry 条目无可安装形态（npm/pypi/remote）' }, 400);
    // Install under the registry short name for readability.
    const shortName = body.server.name.split('/').pop() ?? body.server.name;
    try {
      const result = await setMcpServerForAgent(body.agent, shortName, spec);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Health ──────────────────────────────────────────────────────────────
  app.get('/health', async (c) => {
    const issues = await runHealthChecks();
    return c.json({ issues });
  });

  return app;
}
