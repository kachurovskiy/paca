/** Fixed engineering gates, not a statistical guarantee or evidence of profitability. */
export const FORECAST_POLICY = Object.freeze({ id: 'empirical-session-cohort', version: 1,
  maximumObservations: 4096, lookbackDays: 180, calibrationDays: 60,
  minimumTrainingDates: 30, minimumCalibrationDates: 20, activationBucketMinutes: 15, maximumApprovalDelayMs: 30_000,
  maximumCapitalToDailyLiquidity: 0.001, minimumCompleteFraction: 1,
  quantiles: Object.freeze([0.1, 0.5, 0.9]), minimumCoverage: 0.7, maximumTailFraction: 0.2,
  maximumWidthToCapital: 0.2, maximumMeanShiftToWidth: 0.25,
  clustering: 'earliest offered candidate per date and symbol; equal date weight, equal symbol weight within date',
  calibration: 'later dates only; fixed training distribution; disqualify only; never refit or rerank on calibration',
} as const);
