/**
 * Production bundler: single-file ESM bundles for the server, the stdio MCP
 * entry, and the CLI. better-sqlite3 stays external (native .node binding
 * ships as a normal npm dependency). Workspace @agora/* packages are bundled
 * from their TS sources via the workspace symlinks.
 */
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'apps/server/dist');

execFileSync('pnpm', ['--filter', '@agora/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['better-sqlite3'],
  logLevel: 'info',
  // CJS deps (gray-matter etc.) call require() at runtime; ESM bundles don't
  // have one, so inject createRequire (esbuild-recommended shim).
  banner: {
    js: "import { createRequire as __agoraCreateRequire } from 'node:module'; const require = __agoraCreateRequire(import.meta.url);",
  },
};

const entries = [
  { entryPoints: [join(repoRoot, 'apps/server/src/index.ts')], outfile: join(outDir, 'server.mjs') },
  { entryPoints: [join(repoRoot, 'packages/hub/src/mcp-stdio.ts')], outfile: join(outDir, 'mcp-stdio.mjs') },
  { entryPoints: [join(repoRoot, 'apps/server/src/cli.ts')], outfile: join(outDir, 'cli.mjs') },
];

for (const entry of entries) {
  await build({ ...shared, ...entry });
}

// Ship the web bundle inside the package: dist/web/.
const webDist = join(repoRoot, 'apps/web/dist');
cpSync(webDist, join(outDir, 'web'), { recursive: true });

console.log('bundles written to', outDir);

// Include workspace dependency license texts; this superset also includes build tools.
const notices = ['Agora workspace dependency notices (includes build tools).', 'Codeburn attribution is also distributed as LICENSE-codeburn.'];
const seen = new Set();
const pnpmRoot = join(repoRoot, 'node_modules/.pnpm');
for (const item of readdirSync(pnpmRoot)) {
  const modules = join(pnpmRoot, item, 'node_modules');
  if (!existsSync(modules)) continue;
  const dirs = readdirSync(modules).flatMap(n => n.startsWith('@') ? readdirSync(join(modules,n)).map(x => join(modules,n,x)) : [join(modules,n)]);
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const file of readdirSync(dir).filter(n => /^(license|licence|copying|notice)(\.|$)/i.test(n))) {
      try { notices.push(`\n===== ${id} / ${file} =====\n${readFileSync(join(dir,file), 'utf8')}`); } catch { /* directory */ }
    }
  }
}
writeFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
writeFileSync(join(outDir, 'build-info.json'), JSON.stringify({version:'0.1.1', builtAt:new Date().toISOString(), frontend:'rebuilt from source by bundle.mjs'}, null, 2));
