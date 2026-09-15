import type { MiddlewareHandler } from 'hono';

/** Local-only HTTP boundary. Browser writes must be same-origin and explicit. */
export function localBoundary(port: number, devOrigin?: string): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!hosts.has(host)) return c.json({ error: '不允许的 Host' }, 403);
    const origin = c.req.header('origin');
    if (origin && origin !== `http://${host}` && origin !== devOrigin) {
      return c.json({ error: '不允许的请求来源' }, 403);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('X-Agora-Request') !== '1') return c.json({ error: '缺少本地写入请求标识' }, 403);
      const contentType = c.req.header('content-type');
      if (contentType && contentType.split(';')[0]?.trim() !== 'application/json') {
        return c.json({ error: '写入仅支持 application/json' }, 415);
      }
    }
    await next();
  };
}
