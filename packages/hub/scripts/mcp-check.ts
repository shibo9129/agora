/**
 * End-to-end MCP protocol check: spawn the stdio server and speak JSON-RPC.
 * Usage: ../../node_modules/.bin/tsx scripts/mcp-check.ts (from packages/hub)
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Target: argv[2] may point at a bundle (production check); default dev entry.
const arg = process.argv[2];
const isBundle = arg?.endsWith('.mjs');
const serverPath = arg ?? join(here, '../src/mcp-stdio.ts');
const tsxBin = join(here, '../../../node_modules/.bin/tsx');

const child = isBundle
  ? spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(tsxBin, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });

const pending = new Map<number, (msg: Record<string, unknown>) => void>();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg['id'] as number | undefined;
  if (id !== undefined && pending.has(id)) {
    pending.get(id)!(msg);
    pending.delete(id);
  }
});

let nextId = 1;
function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// 1. initialize
const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'agora-mcp-check', version: '0.1.0' },
});
console.log('initialize:', JSON.stringify(init['result']?.['serverInfo'] ?? init));

// 2. tools/list
const tools = await call('tools/list');
const toolNames = (tools['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
console.log('tools:', toolNames.join(', '));

// 3. memory_search
const search = await call('tools/call', {
  name: 'memory_search',
  arguments: { query: '里程碑' },
});
const searchText = (search['result'] as { content: { text: string }[] }).content[0]!.text;
console.log('memory_search 里程碑 →', searchText.split('\n')[0]);

// 4. memory_write then memory_read
await call('tools/call', {
  name: 'memory_write',
  arguments: {
    name: 'mcp-e2e-check',
    abstract: 'MCP stdio 端到端验证通过（由 mcp-check 脚本写入）',
    body: '该记忆由 Agora MCP server 的端到端协议验证脚本写入。',
    type: 'fact',
    group: 'notes',
    by: 'mcp-check',
  },
});
const read = await call('tools/call', {
  name: 'memory_read',
  arguments: { path: 'global/notes/mcp-e2e-check.md' },
});
console.log('memory_read →', (read['result'] as { content: { text: string }[] }).content[0]!.text.split('\n')[2]);

// 5. kb_search
const kbList = await call('tools/call', { name: 'kb_list', arguments: {} });
console.log('kb_list →', (kbList['result'] as { content: { text: string }[] }).content[0]!.text.split('\n')[0]);

child.kill();
console.log('\nMCP E2E: ALL OK');
process.exit(0);
