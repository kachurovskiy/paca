import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Session } from '../app/session';
import type { Credentials } from '../core/types';
import { forgetCredentials, savedCredentials, saveCredentials, saveWatchlist, watchlist } from '../core/preferences';
import { TerminalView } from './terminal';
import { ScannerView } from './scanner';
import { RobotsView } from './robots';
import { PortfolioView } from './portfolio';
import { money, useFeature } from './hooks';
import { marketStatus } from '../core/market-status';
import { protectionStatus } from '../trading/protection';
import { Segmented, Pnl } from './controls';
import { ApiActivityView } from './api-activity';
import type { Vault } from '../core/vault';

function Connection({ vault, connecting, error, connect, cancel }: { vault: Vault; connecting: boolean; error: string; connect: (credentials: Credentials) => void; cancel: () => void }) {
  const [saved, setSaved] = useState(() => savedCredentials(vault)), [storageError, setStorageError] = useState(''), [forgetting, setForgetting] = useState(false);
  const [keyId, setKey] = useState(saved?.keyId ?? ''), [secretKey, setSecret] = useState(saved?.secretKey ?? ''), [environment, setEnvironment] = useState<'paper' | 'live'>(saved?.environment ?? 'paper');
  const forget = async () => {
    setForgetting(true);
    try { await forgetCredentials(vault); setSaved(null); setKey(''); setSecret(''); setStorageError(''); }
    catch { setStorageError('Saved keys could not be removed. Check your browser storage settings.'); }
    finally { setForgetting(false); }
  };
  return <div class="modal-backdrop"><section class="panel connect-dialog" role="dialog" aria-modal="true" aria-label="Connect Alpaca"><h2>Connect Alpaca</h2>
    <form onSubmit={event => { event.preventDefault(); connect({ keyId, secretKey, environment }); }}>
      <div class="field"><span>Environment</span><Segmented label="Environment" disabled={connecting} value={environment} onChange={setEnvironment} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]} /></div>
      <label>API key<input aria-label="API key" disabled={connecting} autoComplete="off" spellcheck={false} value={keyId} onInput={event => setKey(event.currentTarget.value)} /></label>
      <label>Secret key<input aria-label="Secret key" disabled={connecting} type="password" autoComplete="off" value={secretKey} onInput={event => setSecret(event.currentTarget.value)} /></label>
      <p>Real-time SIP market data is required.</p>
      <p>Keys are encrypted in this browser and used to reconnect after you unlock with your password. Live manual trading and Robot entries must be enabled separately after connecting.</p>
      <p>Before using this version, stop old bots, close old Paca tabs, and resolve old broker orders and inventory explicitly. Existing positions remain external.</p>
      {(error || storageError) && <p role="alert">{error || storageError}</p>}
      <div class="dialog-actions"><button class="primary" disabled={connecting || !keyId.trim() || !secretKey.trim()}>{connecting ? 'Connecting…' : 'Connect account'}</button><button type="button" onClick={cancel}>Cancel</button>
        {saved && <button type="button" disabled={connecting || forgetting} onClick={() => void forget()}>Forget saved keys</button>}</div>
    </form></section></div>;
}
function AccountSummary({ session }: { session: Session }) {
  const portfolio = useFeature(session.portfolio), market = useFeature(session.market);
  const clock = marketStatus(portfolio.clock, Date.now());
  return <div class="account-strip"><dl class="stats-grid" aria-label="Account summary">
    <div><dt>Account equity</dt><dd>{money(portfolio.account?.equity)}</dd></div>
    <div><dt>Today's P/L</dt><dd><Pnl value={portfolio.account ? portfolio.account.equity - portfolio.account.lastEquity : null} /></dd></div>
    <div><dt>Cash balance</dt><dd>{money(portfolio.account?.cash)}</dd></div>
    <div><dt>Buying power</dt><dd>{money(portfolio.account?.buyingPower)}</dd></div>
    <div class="data-stat"><dt>Market data</dt><dd><span class={`status-dot ${market.status === 'ready' ? 'connected' : ''}`} />{market.status} · {market.feed}</dd></div>
  </dl><div class="market-clock"><strong>{clock.status}</strong><small>{clock.countdown}</small></div></div>;
}
function Status({ session }: { session: Session }) {
  const portfolio = useFeature(session.portfolio), market = useFeature(session.market), trading = useFeature(session.trading);
  return <div class="session-status">
    {(trading.hold || market.error || portfolio.error) && <p class="notice" role="alert">{trading.hold || market.error || portfolio.error}</p>}
    {trading.runs.filter(run => run.active && run.orders.some(order => order.side === 'buy' && (order.filledQty ?? 0) > 0))
      .filter(run => ['unprotected', 'unknown', 'pending', 'exiting'].includes(protectionStatus(run).state))
      .map(run => <p class="notice" role="alert" key={run.id}>{run.approved.plan.symbol}: {protectionStatus(run).message}</p>)}
    </div>;
}
function SessionFooter({ session }: { session: Session }) {
  const trading = useFeature(session.trading);
  return <footer class="session-footer"><span>Connected to Alpaca · {session.environment === 'paper' ? 'Paper account' : 'Live account'}</span>
    <ApiActivityView activity={session.apiActivity} />
    <details><summary>Browser supervision required{session.environment === 'live' && ` · Live Robot entries ${trading.liveRobotsArmed ? 'enabled' : 'disabled'}`}</summary>
      <p>Keep this tab open to supervise Robots. Other devices and external broker clients are outside this tab’s lock.</p></details></footer>;
}

const pages = ['terminal', 'scanner', 'robots', 'performance', 'history'] as const;
type Page = typeof pages[number];
const currentPage = (): Page => pages.find(page => location.hash === `#${page}`) ?? 'terminal';
export function App({ vault }: { vault: Vault }) {
  const [initialCredentials] = useState(() => savedCredentials(vault));
  const [session, setSession] = useState<Session | null>(null), [page, setPage] = useState<Page>(currentPage);
  const [symbols, setSymbols] = useState(() => watchlist(vault)), [symbol, setSymbol] = useState(() => watchlist(vault)[0] ?? 'SPY');
  const [dialog, setDialog] = useState(false), [connecting, setConnecting] = useState(!!initialCredentials), [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [locking, setLocking] = useState(false);
  const current = useRef<Session | null>(null), request = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const navigate = () => setPage(currentPage()); addEventListener('hashchange', navigate);
    if (initialCredentials) void connect(initialCredentials);
    return () => { removeEventListener('hashchange', navigate); request.current?.abort(); void current.current?.dispose(); };
  }, []);
  useEffect(() => { session?.watch([...symbols, symbol]); }, [session, symbols, symbol]);
  const disconnect = async () => {
    request.current?.abort(); request.current = null; const prior = current.current;
    current.current = null; setSession(null); await prior?.dispose();
  };
  const cancelConnection = () => {
    request.current?.abort(); request.current = null; setConnecting(false); setDialog(false);
  };
  const connect = async (credentials: Credentials) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setConnecting(true); setError('');
    try {
      const prior = current.current; current.current = null; setSession(null); await prior?.dispose();
      const next = await Session.connect(vault, credentials, symbols, controller.signal);
      if (controller.signal.aborted || request.current !== controller) { await next.dispose(); return; }
      try { await saveCredentials(vault, credentials); setStorageNotice(''); }
      catch { setStorageNotice('Keys could not be saved in this browser. You will need to enter them again next time.'); }
      if (controller.signal.aborted || request.current !== controller) { await next.dispose(); return; }
      current.current = next; setSession(next); setDialog(false);
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'Connection failed.'); setDialog(true);
      }
    }
    finally { if (request.current === controller) setConnecting(false); }
  };
  const changeWatchlist = (values: string[]) => { setSymbols(values); void saveWatchlist(vault, values).catch(() => setStorageNotice('Watchlist preferences could not be saved.')); };
  if (locking) return <main class="unlock-page"><p role="status">Locking workspace…</p></main>;
  return <div class="app"><header class="app-header"><a class="brand" href="#terminal">paca<span>trading terminal</span></a><nav aria-label="Main navigation">{pages.map(value => <a key={value} href={`#${value}`} aria-current={page === value ? 'page' : undefined}>{value}</a>)}</nav>
    <div class="header-actions"><span class={`mode-badge ${session?.environment ?? ''}`}>{session ? session.environment === 'paper' ? 'Paper' : 'Live' : connecting ? 'Connecting' : 'Disconnected'}</span>
      {session ? <button onClick={() => void disconnect()}>Disconnect</button> : <button class="primary" disabled={connecting} onClick={() => { setDialog(true); setError(''); }}>{connecting ? 'Connecting…' : 'Connect Alpaca'}</button>}
      <button title="Disconnect and stop browser supervision" onClick={() => { setLocking(true); void disconnect().then(() => location.reload(), () => location.reload()); }}>Lock app</button></div>
    {session && <AccountSummary session={session} />}</header>
    {storageNotice && <p class="notice" role="alert">{storageNotice}</p>}
    {session && <Status session={session} />}
    <main aria-label="Trading terminal">{!session ? connecting && !dialog ? <section class="panel welcome" aria-busy="true"><span class="eyebrow">ALPACA CONNECTION</span><h1>Connecting to your account</h1><p role="status">Reconnecting to your saved {initialCredentials?.environment} account…</p><button onClick={cancelConnection}>Cancel connection</button></section>
      : <section class="panel welcome"><span class="eyebrow">YOUR MARKETS. ONE WORKSPACE.</span><h1>Your trading workspace</h1><p>Connect Alpaca to load quotes, charts, positions, orders, scanner candidates and supervised Robots.</p><div class="welcome-features"><span>Live market data</span><span>Portfolio insights</span><span>Supervised Robots</span></div><button class="primary" disabled={connecting} onClick={() => setDialog(true)}>Connect account</button><p>Account values and market evidence remain unavailable until connected.</p><small>Watchlist: {symbols.join(', ') || 'Empty'}</small></section>
      : page === 'terminal' ? <TerminalView session={session} symbols={symbols} symbol={symbol} select={setSymbol} changeWatchlist={changeWatchlist} />
        : page === 'scanner' ? <ScannerView session={session} /> : page === 'robots' ? <RobotsView session={session} />
          : <PortfolioView session={session} history={page === 'history'} />}</main>
    {session && <SessionFooter session={session} />}
    {dialog && <Connection vault={vault} connecting={connecting} error={error} connect={credentials => void connect(credentials)} cancel={cancelConnection} />}
  </div>;
}
