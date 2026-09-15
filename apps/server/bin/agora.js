#!/usr/bin/env node
/**
 * agora bin: route subcommands to the bundled entries.
 *   agora [start]   → dist/server.mjs   (default)
 *   agora mcp       → dist/mcp-stdio.mjs
 *   agora collect|doctor → dist/cli.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? 'start';

const target =
  command === 'start'
    ? join(here, '../dist/server.mjs')
    : command === 'mcp'
      ? join(here, '../dist/mcp-stdio.mjs')
      : join(here, '../dist/cli.mjs');

await import(pathToFileURL(target).href);
