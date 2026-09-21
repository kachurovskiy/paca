import type { DataReads } from '../../broker/reads';
import { ResearchDocuments } from '../documents';
import { runChronological, type ResearchSeries } from './chronological';
import { MEAN_REVERSION_POLICY as policy, meanReversionBatch, simulateMeanReversion } from './mean-reversion';
import type { UniverseSnapshot } from './universe';
import { CHRONOLOGICAL_RESEARCH_POLICY } from './policy';
import { canonicalSerialize } from './values';

/** Concrete experiment document: reserve inspected dates, then save the result. */
export async function researchMean(snapshot: UniverseSnapshot, data: Pick<DataReads, 'getBars'>, documents: ResearchDocuments, signal: AbortSignal, now: () => number) {
  const sessions = snapshot.previousSessions.slice(-policy.limits.sessions), series: ResearchSeries[] = [];
  let requests = 0;
  const at = () => new Date(now()).toISOString();
  try {
    if (sessions.length !== policy.limits.sessions) throw new Error('Insufficient independent sessions for VWAP research.');
    for (const candidate of snapshot.candidates.slice(0, policy.limits.symbols)) {
      const symbol = candidate.asset.symbol; requests++;
      // The API interval includes extended hours between regular sessions. Bound
      // that transport separately from the regular-hours research row budget.
      const transportBars = policy.limits.sessions * 24 * 12;
      const response = await data.getBars([symbol], { start: Date.parse(sessions[0].openAt), end: Date.parse(sessions.at(-1)!.closeAt),
        timeframe: '5Min', maxPagesPerBatch: 2, maxBarsPerSymbol: transportBars }, signal);
      if (!response[symbol] || response[symbol].length > transportBars) throw new Error('VWAP history is incomplete.');
      const regular = response[symbol].filter(bar => sessions.some(session => bar.t >= session.openAt && bar.t < session.closeAt));
      if (regular.length > policy.limits.barsPerSymbol) throw new Error('VWAP regular-session history exceeds the research row budget.');
      for (const session of sessions) series.push({ symbol, session, bars: regular.filter(bar => bar.t >= session.openAt && bar.t < session.closeAt)
        .map(bar => ({ bar, availableAt: new Date(Date.parse(bar.t) + 300_000).toISOString() })) });
    }
    if (signal.aborted) throw new Error('Research cancelled.');
    const sourceRef = 'alpaca-sip-split-5min';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(series.map(row => ({
      symbol: row.symbol, date: row.session.tradingDate, open: row.session.openAt, close: row.session.closeAt, bars: row.bars })) )));
    const id = `experiment-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const experiments = (await documents.load()).filter(row => row.kind === 'experiment');
    const prior = experiments.find(row => row.id === id);
    const retryTimedOut = prior?.report?.status === 'budget_exceeded' && prior.report.reasons.includes('duration_budget')
      && canonicalSerialize(prior.report.policy) === canonicalSerialize(CHRONOLOGICAL_RESEARCH_POLICY)
      && canonicalSerialize(prior.report.configurations) === canonicalSerialize(policy.configurations);
    if (prior && !retryTimedOut) return meanReversionBatch(snapshot, at(), prior.report, prior.report ? id : null, requests, 'An earlier experiment remains incomplete.');
    const exposure = sessions.map(session => ({ sourceRef, tradingDate: session.tradingDate }));
    // Continue only identical data/configurations. Preserve the interrupted report
    // until replaced, and retain exposure from every OTHER experiment.
    if (!prior) await documents.saveExperiment(id, exposure, null);
    const report = await runChronological({ data: { id, sourceRef, asOf: snapshot.dataCutoff, dataCutoff: snapshot.dataCutoff,
      calendarEvidence: 'retrospective', selection: { kind: 'supplied_symbols' }, series }, configurations: policy.configurations,
      priorExposure: experiments.filter(row => row.id !== id).flatMap(row => row.exposure), exposureHistoryComplete: true }, simulateMeanReversion,
      { signal, now });
    if (signal.aborted) throw new Error('Research cancelled.');
    await documents.saveExperiment(id, exposure, report);
    return meanReversionBatch(snapshot, at(), report, id, requests);
  } catch (error) { return meanReversionBatch(snapshot, at(), null, null, requests, error instanceof Error ? error.message : 'VWAP research unavailable.'); }
}
