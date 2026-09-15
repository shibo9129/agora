/**
 * Pricing layer: model cost lookup + cost calculation.
 *
 * Adapted from codeburn's `src/models.ts` (https://github.com/getagentseal/codeburn),
 * MIT License — see ../../../LICENSE-codeburn.
 *
 * Pricing data: bundled LiteLLM snapshot (same source as codeburn/ccusage/tokscale)
 * with heuristic defaults for cache rates, matching the ecosystem convention.
 */

import snapshot from './data/litellm-snapshot.json' with { type: 'json' };
import fallback from './data/pricing-fallback.json' with { type: 'json' };

export interface ModelCosts {
  /** USD per token. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** False when cacheWrite rate is the 1.25x heuristic rather than explicit. */
  cacheWriteCostIsExplicit: boolean;
  fastMultiplier: number;
}

type SnapshotTuple = (number | null)[];

const ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE = 1.6;
const WEB_SEARCH_COST_PER_REQUEST = 0.01;

/** Providers whose reported outputTokens already include reasoning tokens. */
const REASONING_INCLUDED_IN_OUTPUT = new Set(['claude-code', 'codex', 'copilot', 'dsh']);

export function billableOutputTokens(agent: string, outputTokens: number, reasoningTokens: number): number {
  return REASONING_INCLUDED_IN_OUTPUT.has(agent)
    ? outputTokens
    : outputTokens + reasoningTokens;
}

function safePerTokenRate(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n > 1) return 1; // clamp garbage
  return n;
}

// ── bundled pricing data (LiteLLM snapshot + fallback gap-fillers) ──
function buildCosts(tuple: SnapshotTuple): ModelCosts | null {
  const input = safePerTokenRate(tuple[0]);
  const output = safePerTokenRate(tuple[1]);
  if (input == null || output == null) return null;
  const explicitCacheWrite = safePerTokenRate(tuple[2]);
  const cacheRead = safePerTokenRate(tuple[3]) ?? input * 0.1;
  const fast = tuple[4];
  return {
    input,
    output,
    cacheWrite: explicitCacheWrite ?? input * 1.25,
    cacheRead,
    cacheWriteCostIsExplicit: explicitCacheWrite != null,
    fastMultiplier: typeof fast === 'number' && fast > 0 ? fast : 1,
  };
}

/** Built-in aliases for common model name drift. */
const BUILTIN_ALIASES: Record<string, string> = {
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-opus-4.5': 'claude-opus-4-5',
  'claude-opus-4.1': 'claude-opus-4-1',
};

/**
 * Normalize a raw model id for pricing lookup: strip `@...` revision suffix,
 * trailing `-YYYYMMDD` dates, and trailing bracket annotations.
 */
export function getCanonicalName(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\s*\[.*\]\s*$/, '');
  m = m.replace(/@.*$/, '');
  m = m.replace(/-\d{8}(-v\d+:\d+)?$/, '$1');
  return BUILTIN_ALIASES[m] ?? m;
}

/** Strip routing prefixes used by gateways/proxies. */
function stripRoutingPrefix(model: string): string {
  return model.replace(/^(omniroute:|cp\/|cline-pass\/|cmd\/|antigravity\/|orcarouter\/)+/, '');
}

/** Drop a leading vendor namespace (`anthropic.`, `openai/`, `azure_ai/`, ...). */
function stripVendorNamespace(model: string): string {
  const slash = model.indexOf('/');
  if (slash > 0) return model.slice(slash + 1);
  const dot = model.indexOf('.');
  if (dot > 0) return model.slice(dot + 1);
  return model;
}

interface PricingIndex {
  exact: Map<string, ModelCosts>;
  /** Keys sorted longest-first for prefix matching. */
  keys: string[];
}

let indexPromise: PricingIndex | null = null;

function buildIndex(): PricingIndex {
  const exact = new Map<string, ModelCosts>();
  const put = (key: string, tuple: SnapshotTuple, overwrite: boolean) => {
    const costs = buildCosts(tuple);
    if (!costs) return;
    const k = key.toLowerCase();
    if (overwrite || !exact.has(k)) exact.set(k, costs);
    const bare = stripVendorNamespace(k);
    if (bare !== k && !exact.has(bare)) exact.set(bare, costs);
  };
  // Snapshot first (direct vendors win over resellers: first write wins).
  for (const [key, tuple] of Object.entries(snapshot as Record<string, SnapshotTuple>)) {
    put(key, tuple, false);
  }
  // Fallback table only fills gaps.
  for (const [key, tuple] of Object.entries(fallback as Record<string, SnapshotTuple>)) {
    put(key, tuple, false);
  }
  const keys = [...exact.keys()].sort((a, b) => b.length - a.length);
  return { exact, keys };
}

function getIndex(): PricingIndex {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
}

/** Replace the pricing tables (used by remote refresh + tests). */
export function __setPricingDataForTests(
  newSnapshot: Record<string, SnapshotTuple>,
  newFallback: Record<string, SnapshotTuple> = {},
): void {
  void snapshot; void fallback; // bundled data superseded
  indexPromise = (() => {
    const exact = new Map<string, ModelCosts>();
    const put = (key: string, tuple: SnapshotTuple) => {
      const costs = buildCosts(tuple);
      if (!costs) return;
      const k = key.toLowerCase();
      if (!exact.has(k)) exact.set(k, costs);
      const bare = stripVendorNamespace(k);
      if (bare !== k && !exact.has(bare)) exact.set(bare, costs);
    };
    for (const [k, t] of Object.entries(newSnapshot)) put(k, t);
    for (const [k, t] of Object.entries(newFallback)) put(k, t);
    return { exact, keys: [...exact.keys()].sort((a, b) => b.length - a.length) };
  })();
}

export function getModelCosts(rawModel: string): ModelCosts | null {
  const { exact, keys } = getIndex();
  const candidates = [getCanonicalName(rawModel), getCanonicalName(stripRoutingPrefix(rawModel))];
  for (const name of candidates) {
    const hit = exact.get(name);
    if (hit) return hit;
    const bare = stripVendorNamespace(name);
    if (bare !== name) {
      const bareHit = exact.get(bare);
      if (bareHit) return bareHit;
    }
  }
  // Prefix match, longest key first (`gpt-5-mini` must not collapse into `gpt-5`).
  for (const name of candidates) {
    for (const key of keys) {
      if (name.startsWith(key)) return exact.get(key) ?? null;
    }
  }
  return null;
}

export interface CostBreakdown {
  costUSD: number;
  /** True when the model has explicit pricing (false = unknown model, cost 0). */
  priced: boolean;
}

/**
 * Compute USD cost. Honest policy: unpriced models return 0, never an estimate.
 * `outputTokens` must already be passed through billableOutputTokens().
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  webSearchRequests = 0,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheWriteTokens = 0,
): CostBreakdown {
  const costs = getModelCosts(model);
  if (!costs) return { costUSD: 0, priced: false };
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1;
  const cacheWriteTotal = Math.max(safe(cacheWriteTokens), safe(oneHourCacheWriteTokens));
  const fiveMinutePart = Math.max(0, cacheWriteTotal - safe(oneHourCacheWriteTokens));
  const cost =
    multiplier *
    (safe(inputTokens) * costs.input +
      safe(outputTokens) * costs.output +
      fiveMinutePart * costs.cacheWrite +
      safe(oneHourCacheWriteTokens) * costs.cacheWrite * ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE +
      safe(cacheReadTokens) * costs.cacheRead +
      safe(webSearchRequests) * WEB_SEARCH_COST_PER_REQUEST);
  return { costUSD: cost, priced: true };
}
