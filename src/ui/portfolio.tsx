import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import type { Period } from '../core/types';
import { download, money, number, useFeature } from './hooks';
import { projectRunMetrics } from '../portfolio/accounting';
import { EmptyRow, Pnl, Segmented, TablePanel, Timestamp } from './controls';
import { PerformanceChart, type PerformanceMetric } from './performance-chart';

const periods: { value: Period; label: string }[] = [{ value: '1D', label: '1D' }, { value: '1W', label: '1W' }, { value: '1M', label: '1M' }, { value: 'ALL', label: 'All time' }];
const shares = (qty: number) => qty.toLocaleString('en-US', { maximumFractionDigits: 9 });

export function PortfolioView({ session, history = false }: { session: Session; history?: boolean }) {
  const model = useFeature(session.portfolio), [period, setPeriod] = useState<Period>('1M'), [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<PerformanceMetric>('pnl');
  useEffect(() => {
    let active = true; setLoading(true);
    const work = history ? session.portfolio.history() : session.portfolio.performance(period);
    void work.finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session, period, history]);
  const projection = session.portfolio.projection(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const values = (metric === 'pnl' ? model.history?.profitLoss : model.history?.equity) ?? [];
  const periodLabel = period === 'ALL' ? 'all time' : period === '1M' ? 'last 30 days' : period.toLowerCase();
  return <div class={`feature-page ${history ? 'history-page' : 'performance-page'}`}><div class="page-heading"><div><span class="eyebrow">YOUR PORTFOLIO</span><h1>{history ? 'Trade history and outcomes' : 'Portfolio performance'}</h1><p>{history ? 'A closer look at your trades and realized results.' : 'Track profit and loss excluding cash transfers, or view total account equity.'}</p></div>
    {history && <div class="toolbar"><button onClick={() => void session.portfolio.history()}>Refresh history</button><button onClick={() => download('paca-history.json', JSON.stringify({ activities: model.activities, complete: model.activitiesComplete, runs: model.historyRuns }, null, 2))}>Export history</button></div>}</div>
    {history ? <>
      <div class="history-note"><p class={model.activitiesError || !model.activitiesComplete ? 'notice' : ''}>{model.activitiesError || (model.activitiesComplete ? 'Broker activity import complete.' : 'History unavailable or incomplete.')}</p>
        <small>Matched long stock fills before fees. {projection.trades.unmatchedSellCount} unmatched sells and {projection.trades.excludedOptionCount} option fills are excluded. Times shown in your local timezone.</small></div>
      <div class="history-grid"><TablePanel title="Monthly results"><table><thead><tr><th>Month</th><th class="numeric">Realized P/L</th><th class="numeric">Trades</th><th class="numeric">Win rate</th><th class="numeric">Profit factor</th></tr></thead><tbody>{projection.summary.months.map(month => <tr key={month.month}><td>{month.month}</td><td class="numeric"><Pnl value={month.realizedPl} /></td><td class="numeric">{month.closedTrades}</td><td class="numeric">{month.winRate === null ? '—' : `${number(month.winRate)}%`}</td><td class="numeric">{number(month.profitFactor)}</td></tr>)}{!projection.summary.months.length && <EmptyRow columns={5}>No closed trades in this history.</EmptyRow>}</tbody></table></TablePanel>
      <TablePanel title="Daily results"><table><thead><tr><th>Date</th><th class="numeric">Realized P/L</th><th class="numeric">Exits</th></tr></thead><tbody>{projection.summary.days.map(day => <tr key={day.date}><td>{day.date}</td><td class="numeric"><Pnl value={day.realizedPl} /></td><td class="numeric">{day.exits}</td></tr>)}{!projection.summary.days.length && <EmptyRow columns={3}>Daily results appear after a closed trade.</EmptyRow>}</tbody></table></TablePanel>
      <TablePanel title="Ticker results" className="full-width"><table><thead><tr><th>Symbol</th><th class="numeric">Closed / open</th><th class="numeric">Realized P/L</th><th class="numeric">Unrealized P/L</th><th class="numeric">Total P/L</th></tr></thead><tbody>{projection.tickers.map(ticker => <tr key={ticker.symbol}><td><strong>{ticker.symbol}</strong></td><td class="numeric">{ticker.closedTrades} / {ticker.openTrades}</td><td class="numeric"><Pnl value={ticker.realizedPl} /></td><td class="numeric"><Pnl value={ticker.unrealizedPl} /></td><td class="numeric"><Pnl value={ticker.totalPl} /></td></tr>)}{!projection.tickers.length && <EmptyRow columns={5}>No ticker results to display.</EmptyRow>}</tbody></table></TablePanel>
      <TablePanel title="Trades" className="full-width">
        <p>Buys for the same ticker and time, including partial fills of one order, form one trade. Sells match the oldest buys first (FIFO).</p>
        <table><thead><tr><th>Opened</th><th>Last sold</th><th>Symbol</th><th>Status</th><th class="numeric">Quantity</th><th class="numeric">Avg. buy</th><th class="numeric">Avg. sell</th><th class="numeric">Realized P/L</th></tr></thead>
          <tbody>{projection.trades.trades.map(trade => <tr key={trade.id}>
            <td><Timestamp value={trade.openedAt} /></td>
            <td>{trade.lastSoldAt ? <Timestamp value={trade.lastSoldAt} /> : '—'}</td>
            <td><strong>{trade.symbol}</strong></td>
            <td><span class="status-badge">{trade.closedAt ? 'Closed' : trade.soldQty > 0 ? 'Partially sold' : 'Open'}</span></td>
            <td class="numeric">{shares(trade.qty)}<small class="cell-detail">{shares(trade.soldQty)} sold · {shares(trade.openQty)} open</small></td>
            <td class="numeric">{money(trade.entryPrice)}</td>
            <td class="numeric">{money(trade.exitPrice)}</td>
            <td class="numeric"><Pnl value={trade.soldQty > 0 ? trade.realizedPl : null} /></td>
          </tr>)}{!projection.trades.trades.length && <EmptyRow columns={8}>No trades in the imported history.</EmptyRow>}</tbody>
        </table>
      </TablePanel></div>
      <section class="panel ended-runs"><h2>Ended Robots</h2>{model.historyRuns.map(run => {
        const metrics = projectRunMetrics(run, new Date().toISOString());
        return <details key={run.id}><summary>{run.approved.plan.symbol} · ended {run.endedAt ? new Date(run.endedAt).toLocaleString() : '—'}</summary>
          <p>Realized gross P/L: <Pnl value={metrics.grossRealizedPnlUsd.value === null ? null : Number(metrics.grossRealizedPnlUsd.value)} /> · Net P/L: <Pnl value={metrics.netTotalPnlUsd.value === null ? null : Number(metrics.netTotalPnlUsd.value)} /></p>
          <p>{metrics.netTotalPnlUsd.reasons.join('; ') || 'Complete attributed fill accounting.'}</p><pre>{JSON.stringify({ run, metrics }, null, 2)}</pre></details>;
      })}{!model.historyRuns.length && <p class="empty-state">Completed Robot runs will appear here.</p>}</section></>
      : <section class="panel performance-panel" aria-busy={loading}><div class="performance-heading"><div><span class="eyebrow">{metric === 'pnl' ? 'PROFIT / LOSS' : 'ACCOUNT EQUITY'}</span><h2 class="equity-value">{loading ? '—' : metric === 'pnl' ? <Pnl value={values.at(-1)} /> : money(values.at(-1))}</h2>
        <span class="performance-return">{!loading && <>{metric === 'equity' && <><Pnl value={model.history?.profitLoss.at(-1)} /> </>}<small>{metric === 'pnl' ? 'Cash transfers excluded' : 'P/L excluding cash transfers'} · {periodLabel}</small></>}</span></div>
        <div class="performance-controls"><Segmented<PerformanceMetric> label="Performance metric" value={metric} onChange={setMetric} options={[{ value: 'pnl', label: 'P/L' }, { value: 'equity', label: 'Equity' }]} />
          <Segmented label="Performance period" value={period} onChange={setPeriod} options={periods} /></div></div>
        {model.historyError && !loading && <p role="alert">{model.historyError}</p>}
        {loading ? <div class="empty-state chart-loading" role="status">Loading performance…</div> : model.history && values.length ? <PerformanceChart history={model.history} metric={metric} /> : <div class="empty-state chart-loading">Performance unavailable.</div>}
        <div class="chart-caption"><small>{metric === 'pnl' ? 'P/L excluding cash transfers' : 'Account equity'} · USD{!loading && model.history && <> · {number(values.length)} observations</>}</small><small>New York time (ET)</small></div></section>}
  </div>;
}
