/**
 * Prepare the desktop sidecar payload (reproducible):
 *   1. refresh the esbuild bundles (server/mcp/cli + web)
 *   2. stage sidecar/ next to src-tauri: node runtime (triple-suffixed),
 *      bundles, and the external native deps (better-sqlite3 chain)
 * Run before `cargo tauri build`. Safe to re-run.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sidecarDir = join(repoRoot, 'apps/desktop/src-tauri/sidecar');

// 1. Refresh bundles.
execFileSync('node', [join(repoRoot, 'scripts/bundle.mjs')], { stdio: 'inherit' });

// 2. Stage sidecar payload.
rmSync(sidecarDir, { recursive: true, force: true });
mkdirSync(sidecarDir, { recursive: true });

const triple = 'aarch64-apple-darwin';
const nodeRuntime = join(sidecarDir, `node-runtime-${triple}`);
cpSync(process.execPath, nodeRuntime);
chmodSync(nodeRuntime, 0o755);

cpSync(join(repoRoot, 'apps/server/dist'), join(sidecarDir, 'dist'), { recursive: true });

const pnpmDir = join(repoRoot, 'node_modules/.pnpm');
for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const entry = readdirSync(pnpmDir).find((d) => d.startsWith(`${pkg}@`));
  if (!entry) throw new Error(`missing pnpm package: ${pkg}`);
  const src = join(pnpmDir, entry, 'node_modules', pkg);
  const dst = join(sidecarDir, 'node_modules', pkg);
  mkdirSync(join(sidecarDir, 'node_modules'), { recursive: true });
  cpSync(src, dst, { recursive: true });
  rmSync(join(dst, 'build/Release/test_extension.node'), { force: true }); // 自测产物，不打进包里
}

if (!existsSync(nodeRuntime)) throw new Error('node runtime staging failed');
console.log('sidecar staged at', sidecarDir);
