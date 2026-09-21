import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { portfolioQuantityPresets } from '../core/quantity';
import { tradingSession } from '../core/trading-session';
import { capitalAvailable } from '../trading/capital';
import { freshQuote } from '../trading/market';
import { manualReviewKey, ManualReviewRequired, previewManual, suggestedManualLimit, type ManualOrder, type ManualPreview } from '../trading/manual-order';
import type { ManualCommand } from '../trading/records';
import { money, number, useFeature } from './hooks';
import { Segmented } from './controls';

function commandStatus(command: ManualCommand): string {
  if (command.status === 'pending') return 'Submitting order…';
  if (command.status !== 'acknowledged' && command.status !== 'resolved') return `${command.status}: ${command.error ?? 'Review the broker outcome.'}`;
  const order = command.order;
  const status = !order || ['new', 'accepted', 'pending_new'].includes(order.status) ? 'Order acknowledged'
    : order.status === 'partially_filled' ? 'Order partially filled' : `Order ${order.status.replaceAll('_', ' ')}`;
  const stop = order?.legs?.[0];
  return `${status}.${order ? ` Filled ${number(order.filledQty)} of ${number(order.qty)} shares.` : ''}${stop ? ` Stop loss at ${priceMoney(stop.stopPrice)}: ${stop.status === 'held' ? 'waiting for full buy fill' : stop.status.replaceAll('_', ' ')}.` : ''}${command.error ? ` Update delayed: ${command.error}` : ''}`;
}

const priceMoney = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—'
  : value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const shares = (value: number) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 9 }) : '—';

export function Ticket({ session, symbol, closeRequest, onBusyChange }: {
  session: Session; symbol: string; closeRequest?: { id: string; symbol: string }; onBusyChange?: (busy: boolean) => void;
}) {
  const account = useFeature(session.portfolio), trading = useFeature(session.trading), market = useFeature(session.market);
  const [side, setSide] = useState<'buy' | 'sell'>('buy'), [type, setType] = useState<'market' | 'limit' | 'stop'>('market');
  const [qty, setQty] = useState('1'), [stopEnabled, setStopEnabled] = useState(false);
  const [stopDraft, setStopDraft] = useState<{ symbol: string; side: 'buy' | 'sell'; value: string } | null>(null);
  const [limitDraft, setLimitDraft] = useState<{ symbol: string; side: 'buy' | 'sell'; value: string; edited: boolean } | null>(null);
  const [timeInForce, setTimeInForce] = useState<'day' | 'gtc'>('day'), [extendedHours, setExtendedHours] = useState(false);
  const [busy, setBusy] = useState(false), [result, setResult] = useState(''), [now, setNow] = useState(Date.now);
  const [submittedSymbol, setSubmittedSymbol] = useState<string | null>(null), [id, setId] = useState<string>(() => crypto.randomUUID());
  const [submittedPreview, setSubmittedPreview] = useState<ManualPreview | null>(null);
  const [review, setReview] = useState<{ draft: ManualOrder; preview: ManualPreview; changed?: boolean } | null>(null);
  const submitting = useRef(false), panel = useRef<HTMLElement>(null), confirmation = useRef<HTMLDivElement>(null);
  const command = trading.manual.find(command => command.id === id);
  const request = command?.action.kind === 'submit' ? command.action.request : null;
  const ticketSymbol = request?.symbol ?? submittedSymbol ?? review?.draft.symbol ?? symbol, locked = busy || !!command || !!review;
  const status = command ? commandStatus(command) : result;
  const position = account.positions.find(position => position.symbol === ticketSymbol), quote = session.market.quote(ticketSymbol);
  const limit = limitDraft?.symbol === ticketSymbol && limitDraft.side === side ? limitDraft.value : '';
  const stop = stopDraft?.symbol === ticketSymbol && stopDraft.side === side ? stopDraft.value : '';
  const suggestedLimit = freshQuote(quote, now, 'limit') ? suggestedManualLimit(side, quote)
    : suggestedManualLimit(side, market.quotes[ticketSymbol]) ?? suggestedManualLimit(side, quote);
  const capital = account.account ? capitalAvailable(account.account, trading.runs, trading.manual, extendedHours) : null;
  const draft: ManualOrder = { symbol: ticketSymbol, side, type, quantity: Number(qty), limitPrice: Number(limit),
    ...(type === 'stop' ? { stopPrice: Number(stop) } : {}),
    ...(side === 'buy' && stopEnabled ? { stopLossPrice: Number(stop) } : {}), timeInForce, extendedHours };
  const currentPreview = previewManual(draft, account.account, position, quote, capital ? capital.availableCents / 100 : null, session.environment);
  const preview = review?.preview ?? submittedPreview ?? currentPreview, order = request ?? preview.request;
  const presets = portfolioQuantityPresets({ side, equity: account.account?.equity, buyingPower: currentPreview.availableCapital ?? undefined,
    price: type === 'limit' ? currentPreview.request.limitPrice : quote?.price, holdings: position?.qty });
  const quoteAge = quote?.quoteAt != null && Number.isFinite(quote.quoteAt) && quote.quoteAt <= now + 5000 ? Math.max(0, Math.floor((now - quote.quoteAt) / 1000)) : null;
  const validBook = quote?.bid != null && quote.ask != null && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask >= quote.bid;
  const spread = validBook ? quote!.ask! - quote!.bid! : null;
  const marketSession = tradingSession(account.clock, now);
  const sessionOpen = extendedHours ? ['regular', 'extended', 'overnight'].includes(marketSession) : marketSession === 'regular';
  const quoteFresh = freshQuote(quote, now, order.type === 'limit' ? 'limit' : 'market')
    && (!order.stopLoss || freshQuote(quote, now, 'market'));
  const validation = currentPreview.error ?? (!sessionOpen ? 'The selected trading session is closed.'
    : !quoteFresh ? 'A fresh price and the required quote/feed are unavailable.' : null);
  const blocked = !!trading.hold || !session.market.ready() || session.environment === 'live' && !trading.liveArmed;

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (review) confirmation.current?.focus(); }, [review]);
  useLayoutEffect(() => {
    if (locked || type !== 'limit' || suggestedLimit === null) return;
    setLimitDraft(current => current?.symbol === ticketSymbol && current.side === side && (current.edited || current.value === String(suggestedLimit)) ? current
      : { symbol: ticketSymbol, side, value: String(suggestedLimit), edited: false });
  }, [locked, type, suggestedLimit, ticketSymbol, side, limitDraft]);
  useEffect(() => {
    if (!closeRequest || submitting.current) return;
    setId(closeRequest.id); setSubmittedSymbol(null); setSubmittedPreview(null); setReview(null); setResult('');
    setSide('sell'); setType('limit'); setStopEnabled(false); setLimitDraft(null); setTimeInForce('day'); setExtendedHours(false);
    setQty(String(session.portfolio.model.positions.find(position => position.symbol === closeRequest.symbol)?.qty ?? 0));
    panel.current?.focus(); panel.current?.scrollIntoView({ block: 'nearest' });
  }, [closeRequest]);

  const send = async (captured: ManualOrder, reviewed: ManualPreview, confirmed: boolean) => {
    if (submitting.current || command) return;
    submitting.current = true; setBusy(true); setSubmittedSymbol(captured.symbol); setSubmittedPreview(reviewed); setResult('');
    try {
      await session.trading.submitManual(id, captured, { key: manualReviewKey(reviewed), confirmed });
      setReview(null); void session.portfolio.refresh();
    } catch (error) {
      setSubmittedSymbol(null); setSubmittedPreview(null);
      if (error instanceof ManualReviewRequired) setReview({ draft: captured, preview: error.preview, changed: true });
      else { setReview(null); setResult(`${captured.side === 'buy' ? 'Buy' : 'Sell'} ${captured.symbol}: ${error instanceof Error ? error.message : 'Order failed.'}`); }
    } finally { submitting.current = false; setBusy(false); }
  };
  const submit = (event: Event) => {
    event.preventDefault(); if (submitting.current || command || review || validation || blocked) return;
    if (currentPreview.confirmationReasons.length) { setResult(''); setReview({ draft, preview: currentPreview }); }
    else void send(draft, currentPreview, false);
  };
  return <section ref={panel} tabIndex={-1} class={`panel order-ticket ${side}`}><header class="ticket-header"><h2>Trade {ticketSymbol}</h2><span class={`ticket-environment ${session.environment}`} title={session.environment === 'live' ? 'Real money' : 'Simulated trading'}>{session.environment === 'live' ? 'Live' : 'Paper'}</span></header><form onSubmit={submit}>
    <Segmented label="Order side" className="trade-side" disabled={locked} value={side} onChange={value => { setSide(value); setStopEnabled(false); if (value === 'buy' && type === 'stop') setType('market'); }} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell holdings' }]} />
    <Segmented label="Order type" disabled={locked} value={type} onChange={value => { setType(value); if (value !== 'limit') setExtendedHours(false); }} options={[{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, ...(side === 'sell' ? [{ value: 'stop' as const, label: 'Stop' }] : [])]} />
    <div class={`ticket-inputs ${type}`}><label>Quantity<input id="quantity" aria-label="Quantity" disabled={locked} type="text" inputMode="decimal" value={qty} onInput={event => setQty(event.currentTarget.value)} /></label>
      {type === 'limit' && <label>Limit price<input aria-label="Limit price" aria-invalid={!!currentPreview.error && currentPreview.error.startsWith('Limit prices')} disabled={locked} type="number" step="any" value={limit} onInput={event => setLimitDraft({ symbol: ticketSymbol, side, value: event.currentTarget.value, edited: true })} /></label>}
      {type === 'stop' && <label>Stop price<input aria-label="Stop price" disabled={locked} type="number" step="any" value={stop} onInput={event => setStopDraft({ symbol: ticketSymbol, side, value: event.currentTarget.value })} /></label>}</div>
    <div class="quantity-presets" role="group" aria-label="Quantity presets">{presets.map(value => <button key={value} type="button" disabled={locked} onClick={() => setQty(String(value))}>{number(value)}</button>)}</div>
    {side === 'buy' && <div class="ticket-stop-loss"><label><input type="checkbox" aria-label="Add stop loss" disabled={locked} checked={stopEnabled} onChange={event => { setStopEnabled(event.currentTarget.checked); if (event.currentTarget.checked) setExtendedHours(false); }} /> Add stop loss</label>
      {stopEnabled && <label><span class="sr-only">Stop-loss price</span><input aria-label="Stop-loss price" placeholder="Stop price" disabled={locked} type="number" step="any" value={stop} onInput={event => setStopDraft({ symbol: ticketSymbol, side, value: event.currentTarget.value })} /></label>}</div>}
    <div class="ticket-choice"><span>Duration</span><Segmented label="Duration" disabled={locked} value={timeInForce} onChange={setTimeInForce} options={[{ value: 'day', label: 'Day' }, { value: 'gtc', label: 'GTC' }]} /></div>
    <div class="ticket-choice"><span>Sessions</span><Segmented label="Trading sessions" disabled={locked || type !== 'limit' || stopEnabled} value={extendedHours ? 'extended' : 'regular'} onChange={value => setExtendedHours(value === 'extended')} options={[{ value: 'regular', label: 'Regular' }, { value: 'extended', label: '+ Extended' }]} /></div>
    <section class="order-review" aria-label="Order summary">
      <div class="ticket-total"><span>Estimated value</span><strong>{money(preview.estimatedValue)}</strong></div>
      <p class="ticket-order-line">{order.side === 'buy' ? 'Buy' : 'Sell'} {shares(order.qty)} {order.symbol} · {order.type === 'market' ? 'Market' : order.type === 'stop' ? `Stop ${priceMoney(order.stopPrice)}` : `Limit ${priceMoney(order.limitPrice)}`}</p>
      {order.stopLoss && <p class="ticket-stop-note">Stop {priceMoney(order.stopLoss.stopPrice)} → market after full buy fill.</p>}
      {order.type === 'stop' && <p class="ticket-stop-note">Triggers a market sell.</p>}
      <p class="ticket-execution-line">{order.timeInForce === 'gtc' ? 'GTC' : 'Day'} · {order.extendedHours ? 'Regular + extended hours' : 'Regular hours only'}</p>
      <dl class="ticket-metrics">
        <div><dt>Available capital</dt><dd>{money(capital ? capital.availableCents / 100 : null)}</dd></div>
        <div><dt>{order.type === 'stop' ? 'Position if triggered' : 'Position after fill'}</dt><dd>{shares(preview.positionQty)} → {shares(preview.positionAfter)} {preview.positionAfter === 1 ? 'share' : 'shares'}</dd></div>
      </dl>
      <p class="ticket-quote-line">Spread {priceMoney(spread)} · <span class={quoteAge === null || quoteAge > 30 ? 'stale-quote' : ''}>Quote {quoteAge === null ? 'unavailable' : `${quoteAge}s${quoteAge > 30 ? ' · stale' : ''}`}</span></p>
      <details class="ticket-details"><summary>Quote &amp; execution details</summary>
        <dl class="order-summary">
          <div><dt>Bid / ask</dt><dd>{priceMoney(quote?.bid)} / {priceMoney(quote?.ask)}</dd></div>
          <div><dt>Paca reservations</dt><dd>{money(capital ? capital.reservedCents / 100 : null)}</dd></div>
          <div><dt>Permitted sessions</dt><dd>{order.extendedHours ? 'Regular + pre-market + after-hours + eligible overnight' : 'Regular · 9:30am–4pm ET'}</dd></div>
        </dl>
        <small>Available capital is after Paca reservations. Estimates assume a full fill; market prices may change.</small>
        {(order.type === 'stop' || order.stopLoss) && <small>Stop triggers a market sell in regular hours; fill price may differ from the stop price.{order.stopLoss && ' The attached stop activates only after the buy fills completely.'}</small>}
        <small>{order.timeInForce === 'gtc' ? 'Good till canceled, with broker expiry up to 90 days. Whole shares only.' : 'Day orders expire after their eligible trading day.'} Paca submits only while a selected session is open.</small>
        {order.extendedHours && <small>Pre-market 4–9:30am, after-hours 4–8pm, overnight 8pm–4am ET. Overnight requires an eligible symbol and account; broker holidays and early closes apply.</small>}
      </details>
    </section>
    {!command && !review && validation && <p class="ticket-validation" role="alert">{validation}</p>}
    {session.environment === 'live' && <label><input type="checkbox" checked={trading.liveArmed} onChange={event => void session.trading.armLive(event.currentTarget.checked)} /> Arm live manual trading for this session</label>}
    {review && !command ? <div class="order-confirmation" role="region" aria-label="Confirm order" ref={confirmation} tabIndex={-1}>
      <strong>{review.changed ? 'Order details changed. Review again.' : 'Confirm this order'}</strong>
      {review.preview.confirmationReasons.map(reason => <p key={reason}>{reason}</p>)}
      <p>{session.environment === 'live' ? 'Live' : 'Paper'}: {review.draft.side === 'buy' ? 'Buy' : 'Sell'} {shares(review.preview.request.qty)} {review.draft.symbol}, estimated {money(review.preview.estimatedValue)}.</p>
      <div class="dialog-actions"><button type="button" disabled={busy} onClick={() => { setReview(null); setSubmittedPreview(null); }}>Edit order</button>
        <button type="button" class="primary" disabled={busy || blocked || !quoteFresh || !sessionOpen} onClick={() => void send(review.draft, review.preview, true)}>{busy ? 'Submitting…' : `Confirm ${review.draft.side} ${review.draft.symbol}`}</button></div>
    </div> : <button class="primary submit-order" disabled={locked || blocked || !!validation}>{busy ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${ticketSymbol}`}</button>}
    {status && <><p role="status">{request && <>{request.side === 'buy' ? 'Buy' : 'Sell'} {request.qty} {request.symbol} · {request.type}{request.type === 'limit' ? ` at $${request.limitPrice}` : request.type === 'stop' ? ` at $${request.stopPrice}` : ''}. </>}{status}</p>
      {!busy && <>{command && <small>Choose New order to prepare another trade.</small>}
        <button type="button" onClick={() => { if (submitting.current) return; setId(crypto.randomUUID()); setSubmittedSymbol(null); setSubmittedPreview(null); setReview(null); setResult(''); }}>New order</button></>}</>}
  </form></section>;
}
