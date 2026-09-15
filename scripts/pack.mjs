/**
 * Create a publishable tarball: bundle → strip workspace-only fields from a
 * COPY of package.json → npm pack → restore. The shipped package needs just
 * one runtime dependency (better-sqlite3, external from the bundle); every
 * @agora/* workspace package is compiled into dist/.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const pkgDir = join(repoRoot, 'apps/server');
const pkgPath = join(pkgDir, 'package.json');

// 1. Bundle (also refreshes dist/web).
execFileSync('node', [join(repoRoot, 'scripts/bundle.mjs')], { stdio: 'inherit' });

// 2. Rewrite a copy of package.json for publication.
const original = readFileSync(pkgPath, 'utf-8');
const pkg = JSON.parse(original);
const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: 'module',
  bin: pkg.bin,
  files: pkg.files,
  engines: pkg.engines,
  dependencies: { 'better-sqlite3': pkg.dependencies['better-sqlite3'] },
  publishConfig: { access: 'public' },
};
const stage = mkdtempSync(join(tmpdir(), 'agora-pack-'));
try {
  for (const name of ['dist', 'bin', 'README.md']) cpSync(join(pkgDir, name), join(stage, name), { recursive: true });
  cpSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));
  cpSync(join(repoRoot, 'packages/usage/LICENSE-codeburn'), join(stage, 'LICENSE-codeburn'));
  cpSync(join(repoRoot, 'THIRD_PARTY_NOTICES.txt'), join(stage, 'THIRD_PARTY_NOTICES.txt'));
  writeFileSync(join(stage, 'package.json'), JSON.stringify(published, null, 2) + '\n');
  execFileSync('npm', ['pack', '--pack-destination', repoRoot], { cwd: stage, stdio: 'inherit' });
} finally { rmSync(stage, { recursive: true, force: true }); }
