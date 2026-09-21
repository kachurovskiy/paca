import { useState } from 'preact/hooks';
import type { Session } from '../app/session';
import { Chart } from './chart';
import { Ticket } from './ticket';
import { money, number, useFeature } from './hooks';
import { isWorkingOrder } from '../core/orders';
import { WatchlistRows } from './watchlist';
import { EmptyRow, Pnl, Segmented } from './controls';

export function TerminalView({ session, symbols, symbol, select, changeWatchlist }: {
  session: Session; symbols: string[]; symbol: string; select: (symbol: string) => void; changeWatchlist: (symbols: string[]) => void;
}) {
  const portfolio = useFeature(session.portfolio), market = useFeature(session.market), trading = useFeature(session.trading);
  const [ticker, setTicker] = useState(symbol), [add, setAdd] = useState(''), [tab, setTab] = useState('positions'), [notice, setNotice] = useState('');
  const [closeRequest, setCloseRequest] = useState<{ id: string; symbol: string }>(), [ticketBusy, setTicketBusy] = useState(false);
  const ownedOrders = new Set(trading.runs.flatMap(run => run.orders.map(order => order.id)));
  const claimed = new Set(trading.runs.filter(run => run.active).map(run => run.approved.plan.symbol));
  const valid = (value: string) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(value);
  const act = async (work: () => Promise<unknown>) => { try { await work(); void session.portfolio.refresh(); setNotice('Command recorded. Order status updates automatically.'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Command unavailable.'); } };
  return <div class="terminal-grid"><aside class="panel watchlist"><h2>Watchlist <small title="Last available 24 hours">24h</small></h2>
    <WatchlistRows market={session.market} symbols={symbols} selected={symbol} quotes={market.quotes}
      select={value => { select(value); setTicker(value); }} remove={value => changeWatchlist(symbols.filter(symbol => symbol !== value))} />
    <form onSubmit={event => { event.preventDefault(); const value = add.trim().toUpperCase(); if (valid(value)) { changeWatchlist([...new Set([...symbols, value])]); setAdd(''); } else setNotice('Enter a valid US stock or ETF symbol.'); }}><input aria-label="Add ticker" placeholder="Add a ticker" value={add} onInput={event => setAdd(event.currentTarget.value)} /><button>Add symbol</button></form>
  </aside><div class="terminal-center"><form class="panel ticker-toolbar toolbar" onSubmit={event => { event.preventDefault(); const value = ticker.trim().toUpperCase(); if (valid(value)) select(value); else setNotice('Enter a valid US stock or ETF symbol.'); }}>
    <input aria-label="Chart ticker" value={ticker} onInput={event => setTicker(event.currentTarget.value)} /><button>Go to ticker</button><div class="quote-summary"><strong>{money(market.quotes[symbol]?.price)}</strong><small>Latest price · {symbol}</small></div></form>
    <Chart market={session.market} symbol={symbol} />
    <section class="panel holdings-panel"><div class="toolbar panel-toolbar"><Segmented label="Account view" value={tab} onChange={setTab} options={[{ value: 'positions', label: `Positions (${portfolio.positions.length})` }, { value: 'orders', label: `Orders (${portfolio.orders.filter(order => isWorkingOrder(order.status)).length})` }]} /><button class="quiet-button" title="Refresh account evidence for diagnostics and recovery" onClick={() => void session.portfolio.refresh()}>Reconcile account</button></div>
      {notice && <p role="status">{notice}</p>}{portfolio.error && <p role="alert">{portfolio.error}</p>}
      <div class="table-scroll" tabIndex={0} role="region" aria-label={tab === 'positions' ? 'Positions table' : 'Orders table'}>{tab === 'positions' ? <table><thead><tr><th>Holding</th><th class="numeric">Shares</th><th class="numeric">Market value</th><th class="numeric">Unrealized P/L</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>{portfolio.positions.map(position => <tr key={position.symbol}><td><button class="symbol-button" onClick={() => { select(position.symbol); setTicker(position.symbol); }}>{position.symbol}</button><small class="cell-detail">{claimed.has(position.symbol) ? 'Robot claim' : 'External / manual'}</small></td><td class="numeric">{number(position.qty)}</td><td class="numeric">{money(position.marketValue)}</td><td class="numeric"><Pnl value={position.unrealizedPl} /></td><td class="row-actions"><button disabled={ticketBusy || claimed.has(position.symbol) || position.side !== 'long'} onClick={() => { select(position.symbol); setTicker(position.symbol); setCloseRequest({ id: crypto.randomUUID(), symbol: position.symbol }); }}>Close holding</button></td></tr>)}{!portfolio.positions.length && <EmptyRow columns={5}>No open positions. Your holdings will appear here.</EmptyRow>}</tbody></table>
        : <table><thead><tr><th>Order</th><th class="numeric">Filled / qty</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>{portfolio.orders.map(order => <tr key={order.id}><td><strong>{order.symbol}</strong> <span class={`side-badge ${order.side}`}>{order.side}</span><small class="cell-detail">{ownedOrders.has(order.id) ? 'Robot' : 'External / manual'}</small><small class="cell-detail">{order.type}{order.stopPrice !== undefined ? ` · Stop $${number(order.stopPrice)}` : order.limitPrice !== undefined ? ` · $${number(order.limitPrice)}` : ''}{order.timeInForce ? ` · ${order.timeInForce.toUpperCase()}` : ''}</small></td><td class="numeric">{number(order.filledQty)} / {number(order.qty)}</td><td><span class="status-badge">{order.status.replaceAll('_', ' ')}</span></td><td class="row-actions">{isWorkingOrder(order.status) && <button disabled={ownedOrders.has(order.id)} onClick={() => void act(() => session.trading.cancelManual(crypto.randomUUID(), order.id))}>Cancel</button>}</td></tr>)}{!portfolio.orders.length && <EmptyRow columns={4}>No orders yet. Submitted orders will appear here.</EmptyRow>}</tbody></table>}</div>
    </section></div><Ticket session={session} symbol={symbol} closeRequest={closeRequest} onBusyChange={setTicketBusy} /></div>;
}
