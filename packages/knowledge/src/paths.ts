import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Reject symlinks at every descendant component, including missing-target parents. */
export async function safeKbPath(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || rel.split('/').includes('..')) throw new Error('路径越界');
  const base = await realpath(root);
  let current = base;
  for (const part of rel.split('/').filter(p => p && p !== '.')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('不允许通过符号链接操作文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return resolve(current);
}
