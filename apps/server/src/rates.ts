/**
 * Live fiat rates: frankfurter.app (ECB reference rates, free, no key) with
 * a 12h memory+disk cache and a static offline fallback. Rates are for display
 * conversion only — costs are always stored in USD. The UI does not accept
 * manual overrides; this module refreshes in the background.
 */
import { Hono } from 'hono';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const PROVIDER_URL = 'https://api.frankfurter.app/latest?from=USD&to=CNY,EUR,HKD';
export const RATES_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_TTL_MS = RATES_CACHE_TTL_MS;

const FALLBACK_RATES = { CNY: 7.2, EUR: 0.92, HKD: 7.8 };

interface RatesSnapshot {
  base: 'USD';
  rates: { CNY: number; EUR: number; HKD: number };
  fetchedAt: string;
  source: 'frankfurter' | 'cache' | 'fallback';
}

function cachePath(): string {
  const home = process.env['AGORA_HOME'] ?? join(homedir(), '.agora');
  return join(home, 'rates-cache.json');
}

let memoryCache: { at: number; snapshot: RatesSnapshot } | null = null;
let inFlight: Promise<RatesSnapshot> | null = null;

function readDiskCache(): RatesSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf-8')) as RatesSnapshot & { at: number };
    if (parsed && typeof parsed.at === 'number' && parsed.rates) return parsed;
  } catch {
    // no usable cache
  }
  return null;
}

async function fetchLive(): Promise<RatesSnapshot> {
  const res = await fetch(PROVIDER_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`rates provider HTTP ${res.status}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  const rates = {
    CNY: body.rates?.['CNY'] ?? FALLBACK_RATES.CNY,
    EUR: body.rates?.['EUR'] ?? FALLBACK_RATES.EUR,
    HKD: body.rates?.['HKD'] ?? FALLBACK_RATES.HKD,
  };
  const snapshot: RatesSnapshot = { base: 'USD', rates, fetchedAt: new Date().toISOString(), source: 'frankfurter' };
  memoryCache = { at: Date.now(), snapshot };
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ at: Date.now(), ...snapshot }), 'utf-8');
  } catch {
    // disk cache is best-effort
  }
  return snapshot;
}

export async function getRates(): Promise<RatesSnapshot> {
  if (memoryCache && Date.now() - memoryCache.at < CACHE_TTL_MS) return memoryCache.snapshot;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await fetchLive();
      } catch {
        const disk = readDiskCache();
        if (disk) return { ...disk, source: 'cache' as const };
        return { base: 'USD' as const, rates: FALLBACK_RATES, fetchedAt: new Date(0).toISOString(), source: 'fallback' as const };
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

export function startRatesRefresh(intervalMs = CACHE_TTL_MS): void {
  void getRates().catch(() => null);
  setInterval(() => {
    memoryCache = null;
    void getRates().catch(() => null);
  }, intervalMs).unref();
}

export function ratesRoutes(): Hono {
  const app = new Hono();
  app.get('/', async (c) => c.json(await getRates()));
  return app;
}
