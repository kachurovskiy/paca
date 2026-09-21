import { useEffect, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { Chart } from './chart';
import { download, money, number, useFeature } from './hooks';
import { ownedInventory } from '../trading/facts';
import { protectionStatus } from '../trading/protection';
import { EmptyRow, Pnl, Segmented, TablePanel, Timestamp } from './controls';
import { ALLOCATION_POLICY } from '../robots/portfolio/allocation';

export function RobotsView({ session }: { session: Session }) {
  const research = useFeature(session.research), trading = useFeature(session.trading), [notice, setNotice] = useState(''), [selected, setSelected] = useState('');
  const [tab, setTab] = useState('proposals');
  const live = session.environment === 'live', entriesEnabled = !live || trading.liveRobotsArmed;
  useEffect(() => { void session.research.load(); }, [session]);
  const act = async (work: () => Promise<unknown>) => { try { await work(); setNotice('Command completed.'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Command unavailable.'); } };
  return <div class="feature-page robots-page"><div class="page-heading"><div><span class="eyebrow">SUPERVISED STRATEGIES</span><h1>{live ? 'Live Robots' : 'Paper Robots'}</h1><p>Research and supervise strategies 24/5, including pre-market, after-hours and overnight.</p></div></div>
    <details class="robot-guidance"><summary>Broker stop protection & browser supervision</summary><p>Regular-hours entries include an attached GTC backup stop. Extended-hours entries use standalone limit orders; the browser attaches a separate backup stop after confirmed fills. Active stops survive Pause, disconnect and browser closure. Strategy exits and trailing stops still require browser supervision.</p>
    <p>Attached stops activate only after a complete entry fill. Partial fills and the cancellation-to-exit transition need supervision. Stops execute during regular market hours and do not guarantee a fill price. Working GTC entries can still fill after the browser closes or the plan ends.</p></details>
    {live && <section class="panel"><label><input type="checkbox" checked={trading.liveRobotsArmed}
      onChange={event => void act(() => session.trading.armLiveRobots(event.currentTarget.checked))} /> Enable live Robot entries for this connection</label>
      <p>Approved plans place orders with real money. Turning entries off asks running Robots to cancel entry orders on their next cycle; they can still fill until cancellation is confirmed. Approved runs continue managing exits.</p>
      <p>Reconnect resets this switch and restores runs paused. Review each plan’s capital ceiling and risk budget before approval.</p></section>}
    <div class="toolbar robot-toolbar"><Segmented label="Robot view" value={tab} onChange={setTab} options={['proposals', 'active', 'research', 'outcomes', 'forecasts'].map(value => ({ value, label: value }))} />
      <button class="primary" disabled={research.busy} onClick={() => void session.research.discover()}>{research.busy ? 'Researching…' : 'Research opportunities'}</button>
      <button onClick={() => void act(() => session.trading.reconcile())}>Reconcile runs</button><button onClick={() => download('paca-research.json', session.research.export())}>Export research</button></div>
    {(notice || trading.hold) && <p role="status">{trading.hold || notice}</p>}
    {tab === 'proposals' && <p>New robots target {ALLOCATION_POLICY.perRunCapBps / 100}% of account equity each. Available cash, existing commitments, risk and liquidity limits can reduce the budget.</p>}
    <p role="status">{research.message}</p>
    {tab === 'proposals' && <>{research.proposals.map(plan => <article class="panel robot-card" key={plan.id}><h2>{plan.symbol} · {plan.template.id}</h2><p>{plan.rationale[0]}</p>
      <dl><dt>Sessions</dt><dd>{plan.sessionMode === '24x5' ? '24/5 including overnight' : 'Regular hours'}</dd><dt>Capital ceiling</dt><dd><strong>{money(plan.capital.ceilingCents / 100)}</strong><br /><small>{number(plan.capital.ceilingCents / plan.capital.equityCents * 100)}% of equity at sizing</small></dd><dt>Risk budget</dt><dd><strong>{money(plan.risk.budgetCents / 100)}</strong></dd><dt>Entry window (local)</dt><dd class="entry-window"><Timestamp value={plan.entryWindow.from} /><span>→</span><Timestamp value={plan.entryWindow.to} /></dd><dt>Parameters</dt><dd>{Object.entries(plan.parameters).map(([name, value]) => `${name}: ${value}`).join(' · ')}</dd></dl>
      <p>{plan.forecast.status === 'unavailable' ? `Forecast unavailable: ${plan.forecast.reason}` : <>Experimental forecast: <Pnl value={plan.forecast.meanPnlCents === null ? null : plan.forecast.meanPnlCents / 100} /></>}</p>
      <details><summary>Strategy rationale & allocation details</summary>{plan.rationale.slice(1).map((reason, index) => <p key={index}>{reason}</p>)}</details>
      <details><summary>Risks, limitations & stop protection</summary>{plan.risks.map((risk, index) => <p key={index}>{risk}</p>)}
        <p>The fixed backup stop uses the tighter of the strategy stop percentage and the run loss trigger, measured from the entry reference price and rounded down to a broker price increment. Regular-hours entries submit it atomically. Extended-hours fills require a separate stop submission and browser supervision. It stays until filled, canceled or expired by Alpaca.</p></details>
      <p class="proposal-caution">Review the plan details before approval. Broker stops do not guarantee a maximum loss. Partial fills, overnight protection and strategy exits require browser supervision. Limit exits may remain unfilled.</p>
      <button class="primary" disabled={Date.now() >= Date.parse(plan.validUntil) || !entriesEnabled || !!trading.hold} onClick={() => void act(() => session.trading.approve(plan.id.slice(-36), plan))}>{live ? 'Approve live plan' : 'Approve frozen plan'}</button>
      <button onClick={() => void session.research.dismiss(plan.id)}>Dismiss</button><button onClick={() => setSelected(plan.symbol)}>Chart</button>
    </article>)}{!research.proposals.length && <section class="panel empty-state"><h2>No proposals yet</h2><p>Choose Research opportunities to find and review a strategy plan.</p></section>}</>}
    {tab === 'active' && <>{trading.runs.filter(run => run.active).map(run => <article class="panel robot-card" key={run.id}><h2>{run.approved.plan.symbol} · {run.approved.plan.template.id}</h2>
      <p>{run.state} · ceiling {money(run.ceilingCents / 100)} · confirmed inventory {number(ownedInventory(run).quantity)}</p><p>{run.blocked}</p><p>Latest decision: {run.latestDecision?.reasonCode ?? 'Unavailable until evaluation'}</p>
      <p role="status">{protectionStatus(run).message}</p>
      {protectionStatus(run).state === 'unprotected' && <button onClick={() => void act(() => session.trading.protect(run.id))}>Attach broker stop</button>}
      <div class="toolbar"><button onClick={() => void act(() => session.trading.pause(run.id))}>Pause</button><button disabled={!entriesEnabled || !!trading.hold} onClick={() => void act(() => session.trading.resume(run.id))}>Resume</button><button onClick={() => void act(() => session.trading.close(run.id))}>Close run</button><button onClick={() => setSelected(run.approved.plan.symbol)}>Chart</button></div>
      <details><summary>Approved plan, orders and command evidence</summary><pre>{JSON.stringify({ approved: run.approved, orders: run.orders, fills: run.fills, commands: run.commands, decision: run.latestDecision }, null, 2)}</pre></details>
    </article>)}{!trading.runs.some(run => run.active) && <p>No active runs.</p>}</>}
    {tab === 'research' && <><TablePanel title="Research results"><table><thead><tr><th>Symbol</th><th>Strategy</th><th>Result</th><th>Reason</th></tr></thead><tbody>{research.candidates.map(row => <tr><td>{row.symbol}</td><td>{row.template}</td><td>{row.status}</td><td>{row.reason.length > 240 ? <details><summary>{row.reason.split('. ')[0]}.</summary><p>{row.reason}</p></details> : row.reason}</td></tr>)}{!research.candidates.length && <EmptyRow columns={4}>Research opportunities to see evaluated candidates.</EmptyRow>}</tbody></table></TablePanel>
      {research.documents.filter(document => document.kind === 'experiment').map(document => <details><summary>Chronological research {document.kind === 'experiment' ? document.id : ''}</summary><pre>{JSON.stringify(document, null, 2)}</pre></details>)}
      <p>Selected research still needs available portfolio capacity to become a proposal. Research results are experimental. Outcome and forecast tabs show retained observations and exclusions.</p></>}
    {tab === 'outcomes' && <><button disabled={research.busy} onClick={() => void session.research.refreshOutcomes()}>Refresh outcomes</button>
      <p>Live and paper results use attributed broker fills and stay separate. Sparse Trend simulations remain separately labeled and excluded from execution forecasting; Wick and VWAP counterfactual fill outcomes remain unavailable.</p>
      <TablePanel title="Recorded outcomes"><table><thead><tr><th>Offer</th><th>Source</th><th>Completeness</th><th class="numeric">Gross P/L</th><th class="numeric">Net P/L</th><th>Evidence</th></tr></thead><tbody>
        {research.documents.flatMap(document => document.kind === 'proposal' ? [<tr key={document.key}><td>{document.proposal.symbol}<br /><small>{document.proposal.session.tradingDate}</small></td>
          <td>{document.outcome?.provenance ?? 'Awaiting outcome'}</td><td>{document.outcome?.completeness ?? 'Unavailable'}</td>
          <td class="numeric"><Pnl value={document.outcome?.grossPnlUsd == null ? null : Number(document.outcome.grossPnlUsd)} /></td><td class="numeric"><Pnl value={document.outcome?.netPnlUsd == null ? null : Number(document.outcome.netPnlUsd)} /></td>
          <td>{document.outcome?.fitExclusions.join('; ') || (document.outcome ? 'Recorded complete outcome' : 'Refresh after the session horizon and confirmed run termination.')}</td></tr>] : [])}
        {!research.documents.some(document => document.kind === 'proposal') && <EmptyRow columns={6}>No recorded outcomes yet.</EmptyRow>}
      </tbody></table></TablePanel></>}
    {tab === 'forecasts' && <><p>Estimates use only earlier, independent, complete observations from comparable plans in this account and environment. The 10th, 50th and 90th outcome percentiles are experimental; they are not guarantees.</p>
      {research.documents.flatMap(document => document.kind === 'proposal' ? [<article class="panel robot-card" key={document.key}><h2>{document.proposal.symbol} · {document.proposal.session.tradingDate}</h2>
        {document.proposal.forecast.status === 'unavailable' ? <p>Forecast unavailable: {document.proposal.forecast.reason}</p>
          : <><p>Mean <Pnl value={document.proposal.forecast.meanPnlCents == null ? null : document.proposal.forecast.meanPnlCents / 100} /> · Median <Pnl value={document.proposal.forecast.medianPnlCents == null ? null : document.proposal.forecast.medianPnlCents / 100} /></p>
            <div class="toolbar">{document.proposal.forecast.quantiles?.map(quantile => <span>{quantile.probability * 100}th percentile: <Pnl value={quantile.pnlCents / 100} /></span>)}</div></>}
        {document.proposal.forecastEvidence && <details><summary>Samples, calibration and exclusions</summary><pre>{JSON.stringify(document.proposal.forecastEvidence, null, 2)}</pre></details>}</article>] : [])}
      {!research.documents.some(document => document.kind === 'proposal') && <p>No current-version offers have been retained. Forecast evidence is unavailable.</p>}</>}
    {selected && <Chart market={session.market} symbol={selected} />}</div>;
}
