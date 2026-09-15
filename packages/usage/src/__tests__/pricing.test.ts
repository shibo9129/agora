import { describe, expect, it } from 'vitest';

import {
  billableOutputTokens,
  calculateCost,
  getCanonicalName,
  getModelCosts,
} from '../pricing/models.js';

describe('billableOutputTokens', () => {
  it('does not double-count reasoning for providers that include it in output', () => {
    expect(billableOutputTokens('claude-code', 100, 40)).toBe(100);
    expect(billableOutputTokens('codex', 100, 40)).toBe(100);
  });
  it('adds reasoning for providers with a separate reasoning bucket', () => {
    expect(billableOutputTokens('opencode', 100, 40)).toBe(140);
  });
});

describe('getCanonicalName', () => {
  it('strips date suffixes and revisions', () => {
    expect(getCanonicalName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(getCanonicalName('claude-haiku-4-5@20251001')).toBe('claude-haiku-4-5');
  });
  it('applies builtin aliases', () => {
    expect(getCanonicalName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
  });
});

describe('getModelCosts', () => {
  it('prices well-known models', () => {
    expect(getModelCosts('claude-sonnet-4-5')).not.toBeNull();
    expect(getModelCosts('gpt-5')).not.toBeNull();
  });
  it('matches through vendor namespaces', () => {
    const direct = getModelCosts('claude-sonnet-4-5');
    const namespaced = getModelCosts('openrouter/anthropic/claude-sonnet-4-5');
    expect(namespaced).not.toBeNull();
    expect(namespaced!.input).toBe(direct!.input);
  });
  it('longest-prefix wins (gpt-5-mini must not collapse into gpt-5)', () => {
    const mini = getModelCosts('gpt-5-mini');
    const five = getModelCosts('gpt-5');
    if (mini && five) expect(mini.input).not.toBe(five.input);
  });
  it('returns null for unknown models (honest zero, never fabricated)', () => {
    expect(getModelCosts('my-internal-model-xyz')).toBeNull();
  });
});

describe('calculateCost', () => {
  it('computes input/output/cache components', () => {
    const costs = getModelCosts('claude-sonnet-4-5')!;
    const { costUSD, priced } = calculateCost('claude-sonnet-4-5', 1000, 500, 100, 200, 0);
    expect(priced).toBe(true);
    const expected =
      1000 * costs.input + 500 * costs.output + 100 * costs.cacheWrite + 200 * costs.cacheRead;
    expect(costUSD).toBeCloseTo(expected, 10);
  });
  it('returns honest zero for unpriced models', () => {
    const { costUSD, priced } = calculateCost('k3-internal', 999999, 999999, 0, 0, 0);
    expect(costUSD).toBe(0);
    expect(priced).toBe(false);
  });
  it('clamps negative/NaN inputs to zero', () => {
    const { costUSD } = calculateCost('claude-sonnet-4-5', -100, NaN, 0, 0, 0);
    expect(costUSD).toBe(0);
  });
});
