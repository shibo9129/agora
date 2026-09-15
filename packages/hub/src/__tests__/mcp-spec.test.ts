import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hubMcpSpec } from '../index.js';

let dir: string;
let originalPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agora-hub-spec-'));
  originalPath = process.env['PATH'];
  // Fake `agora` bin on PATH.
  const bin = join(dir, 'agora');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
});

afterAll(() => {
  if (originalPath !== undefined) process.env['PATH'] = originalPath;
  delete process.env['AGORA_MCP_COMMAND'];
  rmSync(dir, { recursive: true, force: true });
});

describe('hubMcpSpec command resolution', () => {
  it('prefers the installed agora bin on PATH (production)', () => {
    process.env['PATH'] = `${dir}:${originalPath}`;
    expect(hubMcpSpec().command).toEqual([join(dir, 'agora'), 'mcp']);
  });

  it('falls back to the tsx dev entry when no bin exists', () => {
    process.env['PATH'] = '/nonexistent-dir-only';
    const cmd = hubMcpSpec().command;
    expect(cmd[0]).toBe('npx');
    expect(cmd[cmd.length - 1]).toContain('mcp-stdio.ts');
  });

  it('honors AGORA_MCP_COMMAND override', () => {
    process.env['PATH'] = `${dir}:${originalPath}`;
    process.env['AGORA_MCP_COMMAND'] = '/opt/custom/agora serve-mcp';
    expect(hubMcpSpec().command).toEqual(['/opt/custom/agora', 'serve-mcp']);
  });
});
