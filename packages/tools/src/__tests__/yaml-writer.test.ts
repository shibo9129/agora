import { describe, expect, it } from 'vitest';

import { setYamlMcpServer, serializeYamlEntry } from '../index.js';

const HERMES_YAML = `# Hermes 配置（注释必须保留）
provider: custom

mcp_servers:
  api:
    url: https://mcp.example.com/mcp?token=SECRET
    timeout: 120
    connect_timeout: 30
  andromeld:
    command: /Applications/AndroMeld.app/Contents/MacOS/andromeld-mcp-server
  simba:
    url: https://example.com/ai/mcp
    headers:
      Authorization: Bearer TOKEN123
    sampling:
      enabled: false
known_plugin_toolsets:
  cli:
    - spotify
platforms:
  telegram:
    enabled: true
`;

describe('yaml writer', () => {
  it('serializes nested specs via yaml stringify', () => {
    const entry = serializeYamlEntry('agora', {
      command: ['npx', '-y', 'tsx', '/abs/mcp.ts'],
      raw: { timeout: 60 },
    });
    expect(entry).toContain('  agora:');
    expect(entry).toContain('    command: npx');
    expect(entry).toContain('    args:');
    expect(entry).toContain('    timeout: 60');
  });

  it('appends a new entry at the end of the mcp_servers block', () => {
    const next = setYamlMcpServer(HERMES_YAML, 'agora', {
      command: ['npx', '-y', 'tsx', '/abs/mcp-stdio.ts'],
      raw: {},
    });
    expect(next).toContain('  agora:');
    expect(next).toContain('    command: npx');
    // inserted BEFORE the next top-level key
    expect(next.indexOf('  agora:')).toBeLessThan(next.indexOf('known_plugin_toolsets:'));
    // comments and other blocks untouched
    expect(next).toContain('# Hermes 配置（注释必须保留）');
    expect(next).toContain('platforms:');
  });

  it('replaces an existing entry in place, keeping siblings and nested fields', () => {
    const next = setYamlMcpServer(HERMES_YAML, 'simba', {
      url: 'http://new-host/mcp',
      raw: {
        url: 'http://new-host/mcp',
        headers: { Authorization: 'Bearer NEW' },
        timeout: 60,
      },
    });
    expect(next).toContain('url: http://new-host/mcp');
    expect(next).toContain('Authorization: Bearer NEW');
    expect(next).not.toContain('TOKEN123');
    // replace semantics: fields absent from the new spec (e.g. sampling) are dropped
    expect(next).not.toContain('sampling:');
    // siblings intact
    expect(next).toContain('andromeld:');
    expect(next).toContain('command: /Applications/AndroMeld.app');
    expect(next).toContain('known_plugin_toolsets:');
  });

  it('preserves nested structures when copying a full raw spec', () => {
    // Cross-agent copy passes the complete raw from the source registration.
    const fullRaw = {
      url: 'https://example.com/ai/mcp',
      headers: { Authorization: 'Bearer KEPT' },
      sampling: { enabled: false },
      timeout: 120,
    };
    const next = setYamlMcpServer(HERMES_YAML, 'simba', { url: fullRaw.url, raw: fullRaw });
    expect(next).toContain('Authorization: Bearer KEPT');
    expect(next).toContain('sampling:');
    expect(next).toContain('enabled: false');
  });

  it('removes an entry cleanly', () => {
    const next = setYamlMcpServer(HERMES_YAML, 'andromeld', null);
    expect(next).not.toContain('andromeld');
    expect(next).toContain('api:');
    expect(next).toContain('simba:');
    expect(next).toContain('known_plugin_toolsets:');
  });

  it('creates the mcp_servers block when absent', () => {
    const next = setYamlMcpServer('provider: custom\n', 'agora', { url: 'http://x/mcp', raw: {} });
    expect(next).toContain('mcp_servers:');
    expect(next).toContain('  agora:');
    expect(next).toContain('provider: custom');
  });

  it('is a noop removing a missing entry', () => {
    expect(setYamlMcpServer(HERMES_YAML, 'ghost', null)).toBe(HERMES_YAML);
  });
});
