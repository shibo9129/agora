import { describe, expect, it } from 'vitest';
import { RATES_CACHE_TTL_MS } from '../rates.js';

describe('live rates', () => {
  it('refreshes on a 12-hour cadence', () => {
    expect(RATES_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
