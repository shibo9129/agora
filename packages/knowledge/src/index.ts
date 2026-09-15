export * from './paths.js';
export * from './types.js';
export * from './templates.js';
export * from './registry.js';
export * from './indexer.js';
export * from './query.js';
export * from './organize.js';

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KbTemplate } from './types.js';

/** Scaffold a new directory from a template. Fails if any target exists. */
export async function scaffoldTemplate(rootPath: string, template: KbTemplate): Promise<void> {
  for (const dir of template.dirs) {
    await mkdir(join(rootPath, dir), { recursive: true });
  }
  for (const file of template.files) {
    await writeFile(join(rootPath, file.path), file.content, { encoding: 'utf-8', flag: 'wx' });
  }
}
