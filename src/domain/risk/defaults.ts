import { AppConfig } from '../../config.js';
import { RiskLimits } from '../../types.js';

export const defaultRiskLimits = (risk: AppConfig['risk']): RiskLimits => ({
  maxPositionSizePct: risk.maxPositionSizePct,
  maxOrderNotionalUsd: risk.maxOrderNotionalUsd,
  maxGrossExposureUsd: risk.maxGrossExposureUsd,
  dailyLossCapUsd: risk.dailyLossCapUsd,
  maxDrawdownPct: risk.maxDrawdownPct,
  cooldownSeconds: risk.cooldownSeconds,
});
