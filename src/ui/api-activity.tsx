import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ApiActivity } from '../core/api-activity';

export function ApiActivityView({ activity }: { activity: ApiActivity }) {
  const [snapshot, setSnapshot] = useState(() => activity.snapshot()), [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setSnapshot(activity.snapshot());
    const timer = setInterval(() => setSnapshot(activity.snapshot()), 1000);
    return () => clearInterval(timer);
  }, [activity]);
  useLayoutEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  return <>
    <button class="api-activity-trigger" ref={trigger} onClick={() => { setSnapshot(activity.snapshot()); setOpen(true); }} aria-haspopup="dialog">
      Trading API: {snapshot.trading}/min <span aria-hidden="true">·</span> Market Data API: {snapshot.marketData}/min
    </button>
    {open && <dialog ref={dialog} class="panel api-activity-dialog" aria-labelledby="api-activity-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
      <div class="api-activity-heading"><h2 id="api-activity-title">Alpaca API requests</h2><button autoFocus onClick={close} aria-label="Close API request details">Close</button></div>
      <p>Rolling past 60 seconds · Trading API <strong>{snapshot.trading}</strong> · Market Data API <strong>{snapshot.marketData}</strong></p>
      <p>Actual HTTP attempts from this connection, including retries and pagination. Updates every second. Streaming messages are excluded.</p>
      <div class="table-scroll" tabIndex={0} role="region" aria-label="API request breakdown"><table><thead><tr><th>API / method</th><th>Endpoint</th><th class="numeric">Calls</th><th class="numeric">Retries</th><th>Results</th><th class="numeric">Avg. ms</th></tr></thead>
        <tbody>{snapshot.groups.map(group => <tr key={`${group.api}:${group.method}:${group.endpoint}`}><td>{group.api === 'trading' ? 'Trading' : 'Market Data'}<br /><strong>{group.method}</strong></td>
          <td class="api-endpoint"><code>{group.endpoint}</code></td><td class="numeric">{group.count}</td><td class="numeric">{group.retries}</td>
          <td>{Object.entries(group.statuses).map(([status, count]) => `${status}: ${count}`).join(' · ')}{group.failed > 0 && <small class="api-failures">{group.failed} failed</small>}</td>
          <td class="numeric">{group.completed ? Math.round(group.totalDurationMs / group.completed) : '—'}</td></tr>)}</tbody></table></div>
      {!snapshot.groups.length && <p>No API requests in the past 60 seconds.</p>}
    </dialog>}
  </>;
}
