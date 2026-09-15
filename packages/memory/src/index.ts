export * from './types.js';
export * from './store.js';
export * from './sync.js';

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default memory root: <AGORA_HOME|~/.agora>/memory */
export function defaultMemoryRoot(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'memory');
}
