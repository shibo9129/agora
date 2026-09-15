import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { localBoundary } from '../security.js';
const app = new Hono();
app.use('*', localBoundary(7878));
app.post('/write', c => c.json({ ok: true }));
app.get('/', c => c.text('ok'));
const headers = { Host: '127.0.0.1:7878', 'X-Agora-Request': '1', 'Content-Type': 'application/json' };
describe('local HTTP boundary', () => {
  it('allows same-origin writes', async () => {
    expect((await app.request('http://127.0.0.1:7878/write', { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:7878' }, body: '{}' })).status).toBe(200);
  });
  it('rejects untrusted origin, host, and simple browser writes', async () => {
    for (const h of [{ ...headers, Origin: 'http://evil.example' }, { ...headers, Host: 'evil.example' }, { Host: headers.Host, 'Content-Type': 'text/plain' }]) {
      expect((await app.request('http://127.0.0.1:7878/write', { method: 'POST', headers: h, body: '{}' })).status).toBe(403);
    }
  });
});
