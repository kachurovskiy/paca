
/** Engineering thresholds, pending empirical review. Passing is not evidence of an edge. */
export const CHRONOLOGICAL_RESEARCH_POLICY = structuredClone({
  id: 'chronological-research', version: 1,
  limits: { symbols: 4, sessions: 60, barsPerSeries: 80, configurations: 16, folds: 4,
    evaluations: 12_000, durationMs: 20_000 },
  coverage: { intervalMs: 300_000, fraction: 0.9, maximumGapMs: 600_000 },
  split: { initialTrainingSessions: 10, validationSessions: 5, minimumFolds: 2 },
  minimum: { trainingTrades: 10, validationTrades: 5, independentValidationSessions: 10,
    neighbors: 2, stableNeighborFraction: 0.75 },
  neighborhood: { changedAxes: 1, maximumRelativeDistance: 0.25, minimumIntegerStep: 1 },
  selection: 'equal-session-mean-net-return-descending-then-configuration-id; training-only',
  validation: 'fixed-training-winner; disqualify-only; never-fallback-to-a-later-winner',
  costs: [
    { id: 'observed-next', feesBpsPerSide: 1, spreadBpsPerSide: 2, slippageBpsPerSide: 2, observationDelay: 1 },
    { id: 'delayed-stress', feesBpsPerSide: 2, spreadBpsPerSide: 5, slippageBpsPerSide: 8, observationDelay: 2 },
  ],
  baselines: ['cash-zero-interest', 'session-buy-and-hold'],
  labels: { unavailable: 'Missing, invalid or insufficient inputs.', experimental: 'Bounded research with explicit gates and limitations.',
    validated: 'Not issued here: requires separate prospective full-pipeline evidence and empirical review.' },
  limitations: [
    'Thresholds are engineering policy, not statistical significance or universal proof.',
    'Cost rates and observation delays are explicit simulation assumptions, not actual fees or broker fill evidence.',
    'Supplied symbols do not reconstruct historical selection; point-in-time claims require retained selection decisions.',
    'The final fold is untouched only relative to a complete supplied exposure history; missing history is unknown.',
    'Trusted simulation kernels must honor observation availability and fill delay; the API is not a sandbox for arbitrary code.',
    'No numerical forecast or full-pipeline validated badge is issued by this module.',
  ],
} as const);

export type ResearchPolicy = typeof CHRONOLOGICAL_RESEARCH_POLICY;
export type ResearchCost = ResearchPolicy['costs'][number];
