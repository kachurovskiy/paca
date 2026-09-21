import type { Timeframe } from './types';

export const MAX_CHART_BARS = 10_000;
export const CHART_LOOKBACK: Record<Timeframe, number> = { '1Min': 60, '5Min': 180, '15Min': 365, '1Hour': 1095, '1Day': 7300, '1Week': 7300 };
