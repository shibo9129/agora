/**
 * Prepare the desktop sidecar payload (reproducible):
 *   1. refresh the esbuild bundles (server/mcp/cli + web)
 *   2. stage sidecar/ next to src-tauri: node runtime (triple-suffixed),
 *      bundles, and the external native deps (better-sqlite3 chain)
 *   3. prove the staged runtime actually boots and loads better-sqlite3
 * Run before `cargo tauri build`. Safe to re-run.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sidecarDir = join(repoRoot, 'apps/desktop/src-tauri/sidecar');

// ── Pick the node binary to ship ────────────────────────────────────────────
// It is copied ALONE into Agora.app/Contents/MacOS, so it must not link
// against anything outside /usr/lib + /System. A Homebrew node copies fine but
// dies at launch with `Library not loaded: @rpath/libnode.*.dylib`, leaving the
// app with a dead sidecar — which looks like "the app hangs", not "bad build".
// Whatever node happens to run this script is therefore only a candidate.
function nonSystemDeps(bin) {
  const out = execFileSync('otool', ['-L', bin], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(1) // line 0 echoes the binary's own path
    .map((l) => l.trim().split(' ')[0])
    .filter(Boolean)
    .filter((p) => !p.startsWith('/usr/lib/') && !p.startsWith('/System/'));
}

function nodeCandidates() {
  const out = [];
  const push = (p) => {
    if (p && existsSync(p) && !out.includes(p)) out.push(p);
  };
  push(process.env['AGORA_SIDECAR_NODE']); // explicit override wins
  push(process.execPath);
  try {
    push(execFileSync('which', ['node'], { encoding: 'utf8' }).trim());
  } catch {
    // no node on PATH — the other candidates still apply
  }
  push(join(homedir(), '.hermes/node/bin/node'));
  push('/usr/local/bin/node');
  const nvm = join(homedir(), '.nvm/versions/node');
  if (existsSync(nvm)) for (const v of readdirSync(nvm)) push(join(nvm, v, 'bin/node'));
  return out;
}

function pickNodeRuntime() {
  const rejected = [];
  for (const bin of nodeCandidates()) {
    const deps = nonSystemDeps(bin);
    if (deps.length === 0) return bin;
    rejected.push(`  ${bin} → links ${deps.length} non-system dylib(s), e.g. ${deps[0]}`);
  }
  throw new Error(
    'no self-contained node found to ship as the sidecar runtime.\n' +
      `${rejected.join('\n')}\n` +
      'Install an official (statically linked) Node ≥22 — nodejs.org pkg or nvm —\n' +
      'or point AGORA_SIDECAR_NODE at one.',
  );
}

// 1. Refresh bundles.
execFileSync('node', [join(repoRoot, 'scripts/bundle.mjs')], { stdio: 'inherit' });

// 2. Stage sidecar payload.
const runtimeSrc = pickNodeRuntime();
console.log(`sidecar runtime: ${runtimeSrc} (${execFileSync(runtimeSrc, ['-v'], { encoding: 'utf8' }).trim()})`);

rmSync(sidecarDir, { recursive: true, force: true });
mkdirSync(sidecarDir, { recursive: true });

const triple = 'aarch64-apple-darwin';
const nodeRuntime = join(sidecarDir, `node-runtime-${triple}`);
cpSync(runtimeSrc, nodeRuntime);
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

// 3. Smoke-test the staged pair: better-sqlite3 is a native module locked to
// the ABI of the node that compiled it, and the runtime picked above may not
// be the one that ran `pnpm install`. Fail here, loudly, rather than in a
// packaged app where it only shows up as a sidecar that won't start.
try {
  execFileSync(nodeRuntime, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], {
    cwd: sidecarDir,
    stdio: 'pipe',
  });
} catch (err) {
  const detail = err instanceof Error && 'stderr' in err ? String(err.stderr).trim() : String(err);
  throw new Error(
    `staged sidecar runtime cannot load better-sqlite3:\n${detail}\n` +
      `runtime: ${runtimeSrc}\n` +
      'Usually an ABI mismatch — reinstall deps with that same node (`pnpm rebuild better-sqlite3`),\n' +
      'or set AGORA_SIDECAR_NODE to the node used for `pnpm install`.',
  );
}

console.log('sidecar staged at', sidecarDir);
