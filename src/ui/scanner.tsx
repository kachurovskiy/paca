import { useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { Chart } from './chart';
import { useFeature, number } from './hooks';
import { Segmented } from './controls';

export function ScannerView({ session }: { session: Session }) {
  const model = useFeature(session.scanner), [selected, setSelected] = useState(''), [filter, setFilter] = useState('candidates'), [error, setError] = useState('');
  const snapshot = model.snapshot;
  const candidates = [...(snapshot?.rows ?? []), ...(snapshot?.candidates ?? [])];
  const rows = [...new Map([...(snapshot?.reviewRows ?? []), ...candidates].map(row => [row.evaluation.symbol, row])).values()];
  const visible = filter === 'candidates' ? candidates.filter(row => !model.reviews.some(review => review.symbol === row.evaluation.symbol && review.choice === 'dismissed'))
    : rows.filter(row => model.reviews.some(review => review.symbol === row.evaluation.symbol && review.choice === filter));
  const assessment = rows.find(row => row.evaluation.symbol === selected)?.evaluation;
  return <div class="feature-page scanner-page"><div class="page-heading"><div><span class="eyebrow">MARKET DISCOVERY</span><h1>Broad scanner</h1><p>Scan the liquid stock universe 24/5, including pre-market, after-hours and overnight.</p></div></div>
    <div class="panel scanner-controls"><div class="toolbar"><Segmented label="Review filter" value={filter} onChange={setFilter} options={['candidates', 'monitoring', 'reviewed', 'dismissed'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} />
      <label><input type="checkbox" checked={snapshot?.config.enabled ?? false} onChange={event => session.scanner.enabled(event.currentTarget.checked)} /> Scan the broad liquidity universe</label></div>
      <div class="scanner-diagnostics"><span><strong>{number(snapshot?.diagnostics.universeSize)}</strong> symbols</span><span><strong>{number(snapshot?.diagnostics.historyReady)}</strong> histories ready</span><span>{snapshot?.diagnostics.bootstrapProgress}</span></div>
      <p>{snapshot?.message}</p>{(model.error || error) && <p role="alert">{model.error || error}</p>}</div>
    <div class="scanner-grid"><section class="panel table-panel"><h2>Scanner results <small>{visible.length}</small></h2><div class="table-scroll" tabIndex={0} role="region" aria-label="Scanner results table"><table><thead><tr><th>Symbol</th><th class="numeric">Score</th><th>Status</th><th>Review</th></tr></thead><tbody>{visible.map(row => <tr key={row.evaluation.symbol} class={selected === row.evaluation.symbol ? 'selected-row' : ''}><td><button class="symbol-button" aria-pressed={selected === row.evaluation.symbol} onClick={() => setSelected(row.evaluation.symbol)}>{row.evaluation.symbol}</button></td><td class="numeric">{number(row.evaluation.score)}</td><td><span class="status-badge">{row.state}</span></td><td><div class="review-actions">{(['monitoring', 'reviewed', 'dismissed'] as const).map(choice => <button key={choice} aria-pressed={model.reviews.some(review => review.symbol === row.evaluation.symbol && review.choice === choice)} onClick={() => void session.scanner.review(row.evaluation.symbol, choice).catch(error => setError(error.message))}>{choice}</button>)}</div></td></tr>)}</tbody></table></div>
      {!visible.length && <p class="empty-state">No qualifying complete candidates for this view.</p>}
      {filter !== 'candidates' && model.reviews.filter(review => review.choice === filter && !rows.some(row => row.evaluation.symbol === review.symbol)).map(review => <p><button onClick={() => setSelected(review.symbol)}>{review.symbol}</button> · {review.choice} · Current evaluation unavailable</p>)}
    </section>{selected && <div><Chart market={session.market} symbol={selected} />
      <section class="panel"><h2>{selected} observations</h2>{assessment ? <><p>{assessment.qualified ? 'Qualifies now' : 'Not currently qualified'} · {assessment.reasons.join('; ') || assessment.flags.join('; ')}</p>
        <dl><dt>Volume versus usual</dt><dd>{number(assessment.features.sessionRVOL)}×</dd><dt>Recent volume</dt><dd>{number(assessment.features.recentRVOL10)}×</dd>
          <dt>30-minute efficiency</dt><dd>{number(assessment.features.efficiency30)}</dd><dt>Trend fit</dt><dd>{number(assessment.features.r2_30)}</dd>
          <dt>Median spread</dt><dd>{number(assessment.features.medianSpreadBps)} bps</dd><dt>Baseline sessions</dt><dd>{assessment.features.baselineSampleCount}</dd></dl>
        <details><summary>Score components and data status</summary><p>{assessment.dataStatus} · measured {new Date(assessment.evaluationTime).toLocaleString()}</p>
          {assessment.components && <dl>{Object.entries(assessment.components).map(([name, value]) => <><dt>{name}</dt><dd>{number(value)}</dd></>)}</dl>}</details></> : <p>Current evaluation unavailable. Your review choice is retained.</p>}</section>
    </div>}</div></div>;
}
