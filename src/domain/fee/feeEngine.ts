import { AppConfig } from '../../config.js';

export interface JupiterFeeParams {
  platformFeeBps?: number;
  feeAccount?: string;
}

export class FeeEngine {
  constructor(private readonly config: AppConfig['trading']) {}

  calculateExecutionFeeUsd(notionalUsd: number, feeBps = this.config.platformFeeBps): number {
    if (notionalUsd < 0) throw new Error('Notional cannot be negative');
    const fee = (notionalUsd * feeBps) / 10_000;
    return Number(fee.toFixed(8));
  }

  buildJupiterFeeParams(): JupiterFeeParams {
    if (!this.config.jupiterReferralAccount) {
      return {
        platformFeeBps: this.config.jupiterPlatformFeeBps,
      };
    }

    return {
      platformFeeBps: this.config.jupiterPlatformFeeBps,
      feeAccount: this.config.jupiterReferralAccount,
    };
  }

  describeMonetizationModel(): {
    executionAccountingFeeBps: number;
    jupiterReferralEnabled: boolean;
    jupiterPlatformFeeBps: number;
  } {
    return {
      executionAccountingFeeBps: this.config.platformFeeBps,
      jupiterReferralEnabled: Boolean(this.config.jupiterReferralAccount),
      jupiterPlatformFeeBps: this.config.jupiterPlatformFeeBps,
    };
  }
}
