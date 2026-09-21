import { testCipher } from '../../core/vault-test-fixtures';
import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { ScannerDataApi, calendarTimeToUtc } from '../../broker/market-data';
import { accountKey } from '../../core/account';
import { openDatabase } from '../../core/database';
import { ResearchDocuments } from '../documents';
import { meanReversionFixture } from './mean-reversion-fixtures';
import { MEAN_REVERSION_POLICY } from './mean-reversion';
import { researchMean } from './mean-service';

it.each([false, true])('loads extended-hours history within bounded pages and preserves regular-session coverage checks (missing session: %s)', async missingSession => {
  const f = meanReversionFixture(), snapshot = await f.capture(), symbol = snapshot.candidates[0].asset.symbol;
  const regular = new Map(f.history({ start: 0, end: f.now, timeframe: '5Min' }).map(bar => [bar.t, bar]));
  const start = Date.parse(snapshot.previousSessions[0].openAt), end = Date.parse(snapshot.previousSessions.at(-1)!.closeAt);
  const rows = f.previous.flatMap(session => Array.from({ length: 192 }, (_, index) => {
    const t = new Date(calendarTimeToUtc(session.date, '04:00') + index * 300_000).toISOString();
    return regular.get(t) ?? { t, o: 100, h: 101, l: 99, c: 100, v: 100_000, vw: 100 };
  })).filter(bar => Date.parse(bar.t) >= start && Date.parse(bar.t) < end
    && !(missingSession && bar.t >= snapshot.previousSessions[5].openAt && bar.t < snapshot.previousSessions[5].closeAt));
  expect(rows.length).toBeGreaterThan(MEAN_REVERSION_POLICY.limits.barsPerSymbol);
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const second = new URL(String(input)).searchParams.has('page_token');
    return new Response(JSON.stringify({ bars: { [symbol]: second ? rows.slice(1000) : rows.slice(0, 1000) }, next_page_token: second ? null : 'page-2' }));
  });
  const api = new ScannerDataApi({ keyId: 'synthetic-key', secretKey: 'synthetic-secret', environment: 'paper' },
    { fetch: fetcher, minRequestIntervalMs: 0, maxRetries: 0 });
  const db = await openDatabase(await testCipher(), `mean-history-${crypto.randomUUID()}`), documents = new ResearchDocuments(db, accountKey(snapshot.scope));
  try {
    const batch = await researchMean(snapshot, api, documents, new AbortController().signal, () => f.now);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const experiments = (await documents.load()).filter(row => row.kind === 'experiment');
    expect(experiments).toHaveLength(1);
    expect(experiments[0].report?.gates).toBe(missingSession ? 'failed' : 'passed');
    expect(batch.evaluations[0].status).toBe(missingSession ? 'unavailable' : 'selected');
    if (missingSession) expect(experiments[0].report?.reasons).toContain('data_coverage');
    else {
      expect(experiments[0].report?.breadth.suppliedSessions).toBe(20);
      // Extended-hour rows affect neither the experiment identity nor its research.
      const regularBatch = await researchMean(snapshot, f.api, documents, new AbortController().signal, () => f.now);
      expect(regularBatch.evaluations).toEqual(batch.evaluations);
      expect((await documents.load()).filter(row => row.kind === 'experiment')).toHaveLength(1);
    }
  } finally { api.dispose(); db.close(); }
}, 20_000);

it.each([false, true])('recovers an identical timed-out experiment while retaining other exposure (other experiment: %s)', async otherExperiment => {
  const f = meanReversionFixture(), snapshot = await f.capture();
  const db = await openDatabase(await testCipher(), `mean-retry-${crypto.randomUUID()}`), documents = new ResearchDocuments(db, accountKey(snapshot.scope));
  try {
    let reads = 0;
    const first = await researchMean(snapshot, f.api, documents, new AbortController().signal, () => f.now + (reads++ ? 20_000 : 0));
    expect(first.evaluations[0].reason).toContain('duration_budget');
    const saved = (await documents.load()).find(row => row.kind === 'experiment')!;
    expect(saved.report?.status).toBe('budget_exceeded');
    if (otherExperiment) await documents.saveExperiment('another-experiment', saved.exposure, null);
    const retried = await researchMean(snapshot, f.api, documents, new AbortController().signal, () => f.now + 20_000);
    const recovered = (await documents.load()).find(row => row.kind === 'experiment' && row.id === saved.id)!;
    expect(recovered.kind === 'experiment' && recovered.report?.status).toBe('complete');
    expect(recovered.kind === 'experiment' && recovered.exposure).toEqual(saved.exposure);
    expect(retried.evaluations[0].status).toBe(otherExperiment ? 'unavailable' : 'selected');
    if (otherExperiment) expect(retried.evaluations[0].reason).toContain('holdout_exhausted');
    // Completed rejections/successes remain cached; retrying is recovery, not a new search.
    const save = vi.spyOn(documents, 'saveExperiment');
    await researchMean(snapshot, f.api, documents, new AbortController().signal, () => f.now + 21_000);
    expect(save).not.toHaveBeenCalled();
  } finally { db.close(); }
}, 20_000);
