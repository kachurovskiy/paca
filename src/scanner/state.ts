import { DEFAULT_SCANNER_CONFIG } from './engine';
import type { ScannerConfig, ScannerEvaluation } from './types';

export type ScannerRowState = 'clean' | 'fading' | 'pending' | 'unavailable';
export interface ScannerRow {
  symbol: string; evaluation: ScannerEvaluation; state: ScannerRowState;
  qualifiedStreak: number; failedStreak: number; admitted: boolean;
}
interface MinuteBaseline { qualifiedStreak: number; failedStreak: number; admitted: boolean }
export interface ScannerRecentRow extends ScannerRow { lastQualifiedAt: number }
export interface ScannerEntry extends ScannerRow { lastMinute: number; baseline: MinuteBaseline; lastQualifiedAt: number | null }
export interface ScannerState {
  configVersion: number; sessionDate: string | null; entries: Record<string, ScannerEntry>;
  rows: ScannerRow[]; recentRows: ScannerRecentRow[]; visible: string[]; lastMinute: number | null;
  cutoffChallenges: Record<string, { incumbent: string; minutes: number; lastMinute: number }>;
}

export function createScannerState(config: ScannerConfig = DEFAULT_SCANNER_CONFIG): ScannerState {
  return { configVersion: config.version, sessionDate: null, entries: {}, rows: [], recentRows: [], visible: [], lastMinute: null, cutoffChallenges: {} };
}

function scoreOrder(entries: Record<string, ScannerEntry>, previousOrder: string[]): (a: string, b: string) => number {
  const order = new Map(previousOrder.map((symbol, index) => [symbol, index]));
  return (a, b) => Number(entries[b].state === 'clean') - Number(entries[a].state === 'clean') || (entries[b].evaluation.score ?? -Infinity) - (entries[a].evaluation.score ?? -Infinity) || (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Pure state transition: revisions derive streaks from the saved prior-minute state. */
export function updateScannerState(previous: ScannerState, evaluations: ScannerEvaluation[], config: ScannerConfig = DEFAULT_SCANNER_CONFIG): ScannerState {
  const sessionDate = evaluations[0]?.sessionDate ?? previous.sessionDate;
  const reset = previous.configVersion !== config.version || (previous.sessionDate !== null && previous.sessionDate !== sessionDate);
  const source = reset ? createScannerState(config) : previous;
  const next: ScannerState = { ...source, sessionDate, entries: { ...source.entries }, rows: [], visible: [...source.visible], cutoffChallenges: { ...source.cutoffChallenges } };
  for (const evaluation of evaluations) {
    if (evaluation.configVersion !== config.version || evaluation.sessionDate !== sessionDate) continue;
    const old = next.entries[evaluation.symbol];
    if (old && evaluation.minute < old.lastMinute) continue;
    const newMinute = !old || evaluation.minute > old.lastMinute;
    const contiguous = old && evaluation.minute === old.lastMinute + 1;
    const baseline: MinuteBaseline = newMinute
      ? { qualifiedStreak: contiguous ? old.qualifiedStreak : 0, failedStreak: contiguous ? old.failedStreak : 0, admitted: old?.admitted ?? false }
      : old.baseline;
    let qualifiedStreak = 0, failedStreak = 0, admitted = baseline.admitted;
    let state: ScannerRowState = 'pending';
    if (evaluation.hardFailure) { admitted = false; state = 'unavailable'; }
    else if (evaluation.qualified) { qualifiedStreak = baseline.qualifiedStreak + 1; admitted ||= qualifiedStreak >= config.admissionMinutes; state = admitted ? 'clean' : 'pending'; }
    else {
      failedStreak = baseline.failedStreak + 1;
      // A row already shown this minute immediately becomes Fading, including
      // a revision/quote failure on its admission minute. It cannot stay Clean,
      // and the failure streak still derives only from the prior minute.
      admitted = (admitted || (old?.admitted ?? false)) && failedStreak < config.removalMinutes;
      state = admitted ? 'fading' : 'pending';
    }
    // A hard invalidation destroys prior admission even if data recovers later in this minute.
    const storedBaseline = evaluation.hardFailure ? { qualifiedStreak: 0, failedStreak: 0, admitted: false } : baseline;
    const lastQualifiedAt = evaluation.qualified && admitted ? evaluation.evaluationTime : old?.lastQualifiedAt ?? null;
    next.entries[evaluation.symbol] = { symbol: evaluation.symbol, evaluation, state, qualifiedStreak, failedStreak, admitted, lastMinute: evaluation.minute, baseline: storedBaseline, lastQualifiedAt };
    next.lastMinute = Math.max(next.lastMinute ?? evaluation.minute, evaluation.minute);
  }
  const compare = scoreOrder(next.entries, source.visible);
  let visible = source.visible.filter(symbol => next.entries[symbol]?.admitted && !next.entries[symbol].evaluation.hardFailure).slice(0, config.maxResults);
  const challengers = Object.keys(next.entries).filter(symbol => next.entries[symbol].admitted && next.entries[symbol].state === 'clean' && !visible.includes(symbol)).sort(compare);
  const activeChallenges = new Set<string>();
  for (const challenger of challengers) {
    if (visible.length < config.maxResults) { visible.push(challenger); continue; }
    const weakest = [...visible].sort(compare).at(-1)!;
    if (next.entries[weakest].state === 'fading') { visible = visible.filter(symbol => symbol !== weakest); visible.push(challenger); continue; }
    const challengerEntry = next.entries[challenger], incumbentEntry = next.entries[weakest];
    if (challengerEntry.evaluation.score === null || incumbentEntry.evaluation.score === null || challengerEntry.evaluation.score < incumbentEntry.evaluation.score + config.replacementScoreMargin) continue;
    activeChallenges.add(challenger);
    const prior = source.cutoffChallenges[challenger];
    const sameIncumbent = prior?.incumbent === weakest;
    const minute = challengerEntry.lastMinute;
    const minutes = sameIncumbent && prior.lastMinute === minute ? prior.minutes : sameIncumbent && prior.lastMinute + 1 === minute ? prior.minutes + 1 : 1;
    next.cutoffChallenges[challenger] = { incumbent: weakest, minutes, lastMinute: minute };
    if (minutes >= config.replacementMinutes) { visible = visible.filter(symbol => symbol !== weakest); visible.push(challenger); delete next.cutoffChallenges[challenger]; }
  }
  for (const challenger of Object.keys(next.cutoffChallenges)) if (!activeChallenges.has(challenger)) delete next.cutoffChallenges[challenger];
  // Ranking is minute-based. Same-minute quote checks/revisions update labels and removals only.
  if (next.lastMinute !== source.lastMinute || reset) visible.sort(compare);
  next.visible = visible;
  next.rows = visible.map(symbol => next.entries[symbol]);
  // Keep recently qualified discoveries inspectable after removal without
  // admitting stale data or weakening any live qualification requirement.
  const entries = Object.values(next.entries);
  const evaluatedAt = Math.max(...entries.map(entry => entry.evaluation.evaluationTime));
  next.recentRows = entries
    .filter((entry): entry is ScannerEntry & ScannerRecentRow => !entry.admitted && entry.lastQualifiedAt !== null && evaluatedAt - entry.lastQualifiedAt < 15 * 60_000)
    .sort((a, b) => b.lastQualifiedAt - a.lastQualifiedAt || a.symbol.localeCompare(b.symbol))
    .slice(0, config.maxResults);
  return next;
}
