import { useEffect, useState } from 'preact/hooks';
import type { Bar, Quote } from '../core/types';
import type { Market } from '../market/service';
import { WATCHLIST_BAR_MS, WATCHLIST_WINDOW_MS, watchlistTrend } from '../market/watchlist-history';
import { money } from './hooks';

interface History { bars: readonly Bar[]; failed: boolean }

function Sparkline({ symbol, history, quote }: { symbol: string; history?: History; quote?: Quote }) {
  const { points, changePercent, end } = watchlistTrend(history?.bars ?? [], quote, Date.now());
  if (!history || history.failed && !history.bars.length || !points.length) {
    return <span class="watchlist-chart-empty">{!history ? 'Loading 24h…' : history.failed ? '24h unavailable' : 'No price history'}</span>;
  }
  const minimum = Math.min(...points.map(point => point.price)), maximum = Math.max(...points.map(point => point.price));
  const range = maximum - minimum;
  const x = (at: number) => 3 + (at - (end - WATCHLIST_WINDOW_MS)) / WATCHLIST_WINDOW_MS * 94;
  const y = (price: number) => range ? 29 - (price - minimum) / range * 24 : 17;
  // Leave gaps when there are no observations instead of drawing through a market closure.
  const path = points.map((point, index) => `${!index || point.at - points[index - 1].at > WATCHLIST_BAR_MS * 3 ? 'M' : 'L'}${x(point.at).toFixed(2)},${y(point.price).toFixed(2)}`).join(' ');
  const last = points.at(-1)!, rounded = Math.round((changePercent ?? 0) * 100) / 100;
  const change = changePercent === null ? '—' : `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`;
  const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
  const description = `24h ending ${new Date(end).toLocaleString()}: ${changePercent === null ? 'One price available; change unavailable' : `${change} across available prices`}. Gaps indicate no observations.${history.failed ? ' Refresh unavailable; showing saved history.' : ''}`;
  return <span class={`watchlist-trend ${direction}`} title={description}>
    <svg class="watchlist-sparkline" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label={`${symbol} price over the last available 24 hours`}>
      <title>{description}</title>
      <line class="sparkline-baseline" x1="3" x2="97" y1={y(points[0].price)} y2={y(points[0].price)} />
      <path d={path} fill="none" stroke="currentColor" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx={x(last.at)} cy={y(last.price)} r="2" fill="currentColor" />
    </svg>
    <span class="watchlist-change" aria-label={`Change across the last available 24 hours: ${changePercent === null ? 'unavailable' : change}`}>{change}</span>
  </span>;
}

export function WatchlistRows({ market, symbols, selected, quotes, select, remove }: {
  market: Market; symbols: string[]; selected: string; quotes: Readonly<Record<string, Quote>>;
  select: (symbol: string) => void; remove: (symbol: string) => void;
}) {
  const [histories, setHistories] = useState<Record<string, History>>({});
  useEffect(() => {
    const controller = new AbortController();
    setHistories(prior => Object.fromEntries(symbols.filter(symbol => prior[symbol]).map(symbol => [symbol, prior[symbol]])));
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      let next = 0;
      const worker = async () => {
        while (!controller.signal.aborted && next < symbols.length) {
          const symbol = symbols[next++];
          let history: History;
          try { history = { bars: await market.watchlistBars(symbol, controller.signal), failed: false }; }
          catch { history = { bars: [], failed: true }; }
          if (!controller.signal.aborted) setHistories(prior => ({ ...prior, [symbol]: {
            ...history, bars: history.bars.length ? history.bars : prior[symbol]?.bars ?? [],
          } }));
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(3, symbols.length) }, worker)); }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 120_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [market, symbols]);
  return <>{symbols.map(symbol => <div class="watchlist-row" key={symbol}>
    <button class="watchlist-symbol" aria-label={`Show ${symbol} chart`} aria-pressed={selected === symbol} onClick={() => select(symbol)}>
      <span class="watchlist-quote"><strong>{symbol}</strong><span>{money(quotes[symbol]?.price)}</span></span>
      <Sparkline symbol={symbol} history={histories[symbol]} quote={quotes[symbol]} />
    </button>
    <button class="watchlist-remove" aria-label={`Remove ${symbol}`} onClick={() => remove(symbol)}>×</button>
  </div>)}</>;
}
