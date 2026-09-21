/** Scanner time values are UTC epoch milliseconds. Prices/returns use USD/fractions. */
export interface ScannerBar { t: string; o: number; h: number; l: number; c: number; v: number; vw: number | null }
export interface ScannerSession { mode?: 'overnight' | 'premarket' | 'afterhours'; date: string; open: number; close: number }
export interface ScannerConfig {
  version: number; enabled: boolean; statusChannelEnabled: boolean; baseUniverseSize: number; quoteShortlistSize: number; maxResults: number;
  discoveryIntervalSeconds: number; barGraceSeconds: number; snapshotLimit: number;
  baselineTargetSessions: number; baselineMinSessions: number;
  admissionMinutes: number; removalMinutes: number; replacementMinutes: number; replacementScoreMargin: number;
  minPrice: number; minAverageDailyRthDollarVolume: number; minDollarVolume5m: number;
  minSessionRVOL: number; minRecentRVOL10: number; minEfficiency30: number; minR2_30: number;
  minVwapHold30: number; maxJumpShare: number; minReturn30: number; minimumMoveToSpreadMultiple: number;
  maxMedianSpreadBps: number; maxCurrentSpreadBps: number; maxQuoteAgeSeconds: number;
  anchors: { efficiency: [number, number]; r2: [number, number]; sessionRVOL: [number, number]; recentRVOL: [number, number]; vwapHold: [number, number]; spreadBps: [number, number] };
}
export interface HistoricalScannerSession { session: ScannerSession; bars: ScannerBar[]; complete: boolean; regularSession?: ScannerSession; regularBars?: ScannerBar[] }
/** Historical requests must use split adjustment to today's share basis. */
export interface VolumeProfile {
  valid: boolean; sampleCount: number; sessionDates: string[]; meanMinuteVolume: number[];
  meanCumulativeVolume: number[]; averageDailyRthDollarVolume: number | null; reasons: string[];
}
export interface ScannerQuote { t: string; bp: number; ap: number; bs: number; as: number }
export interface QuoteMetrics {
  valid: boolean; currentSpreadBps: number | null; medianSpreadBps: number | null;
  quoteAgeSeconds: number | null; validSamples: number; reasons: string[];
}
export interface ScannerFeatures {
  price: number | null; priceTimestamp: string | null; dailyChange: number | null;
  sessionRVOL: number | null; recentRVOL10: number | null; dollarVolume5m: number | null;
  averageDailyRthDollarVolume: number | null; efficiency30: number | null;
  slope30: number | null; r2_30: number | null; slope10: number | null; r2_10: number | null;
  slope60: number | null; r2_60: number | null; return30: number | null; return10: number | null; return60: number | null;
  sessionVWAP: number | null; vwapHold30: number | null; vwapDistance: number | null;
  jumpShare: number | null; currentSpreadBps: number | null; medianSpreadBps: number | null;
  quoteAgeSeconds: number | null; quoteSamples: number; baselineSampleCount: number;
  ema9: number | null; atr14: number | null; extended: boolean; confirmed60: boolean;
  sparkline: number[];
}
export interface ScoreComponents { efficiency: number; r2: number; sessionRVOL: number; recentRVOL: number; vwapHold: number; spread: number }
export type ScannerDataStatus = 'ready' | 'forming' | 'loading-history' | 'warming-quotes' | 'unavailable' | 'closed';
export interface ScannerEvaluation {
  symbol: string; sessionDate: string; evaluationTime: number; minute: number; configVersion: number;
  qualified: boolean; hardFailure: boolean; dataStatus: ScannerDataStatus; reasons: string[];
  features: ScannerFeatures; score: number | null; components: ScoreComponents | null; flags: string[];
}
export interface ScannerEvaluationInput {
  symbol: string; bars: ScannerBar[]; session: ScannerSession; evaluationTime: number;
  /** Complete REST coverage from session open; missing extended-session bars are observed omissions. */
  barsCoveredThrough?: number;
  profile: VolumeProfile | null; quote: QuoteMetrics | null; eligible: boolean; halted?: boolean;
  priorClose?: number | null; config?: ScannerConfig;
}
