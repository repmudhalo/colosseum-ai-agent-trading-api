import { describe, expect, it } from 'vitest';
import { FeeEngine } from '../src/domain/fee/feeEngine.js';

const tradingConfig = {
  platformFeeBps: 10,
  jupiterReferralAccount: 'RefFee1111111111111111111111111111111111111',
  jupiterPlatformFeeBps: 20,
} as const;

describe('FeeEngine', () => {
  it('computes execution fee in USD from bps', () => {
    const feeEngine = new FeeEngine(tradingConfig as never);
    expect(feeEngine.calculateExecutionFeeUsd(1000)).toBe(1);
    expect(feeEngine.calculateExecutionFeeUsd(333.33, 30)).toBe(0.99999);
  });

  it('throws for negative notional', () => {
    const feeEngine = new FeeEngine(tradingConfig as never);
    expect(() => feeEngine.calculateExecutionFeeUsd(-1)).toThrow();
  });

  it('returns Jupiter referral plumbing params', () => {
    const feeEngine = new FeeEngine(tradingConfig as never);
    expect(feeEngine.buildJupiterFeeParams()).toEqual({
      platformFeeBps: 20,
      feeAccount: tradingConfig.jupiterReferralAccount,
    });
  });

  it('describes monetization state for metrics/docs', () => {
    const feeEngine = new FeeEngine(tradingConfig as never);
    expect(feeEngine.describeMonetizationModel()).toEqual({
      executionAccountingFeeBps: 10,
      jupiterReferralEnabled: true,
      jupiterPlatformFeeBps: 20,
    });
  });
});
