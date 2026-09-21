import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bar, Timeframe } from '../core/types';
import type { Market } from '../market/service';
import { money } from './hooks';
import { computeIndicators } from '../market/indicators';
import { Segmented } from './controls';

const intervals: { value: Timeframe; label: string }[] = [{ value: '1Min', label: '1m' }, { value: '5Min', label: '5m' }, { value: '15Min', label: '15m' }, { value: '1Hour', label: '1h' }, { value: '1Day', label: '1D' }, { value: '1Week', label: '1W' }];
const exchangeTime = (value: string, daily = false) => new Date(value).toLocaleString('en-US', {
  timeZone: 'America/New_York', ...(daily ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false }),
});

/** Canvas instance survives every quote/account refresh. Only real unmount destroys it. */
class CandleCanvas {
  private bars: readonly Bar[] = [];
  private count = 200;
  private ema = true;
  private vwap = false;
  private timeframe: Timeframe = '5Min';
  private readonly observer: ResizeObserver;
  constructor(private readonly canvas: HTMLCanvasElement) {
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(canvas);
    canvas.addEventListener('wheel', this.zoom, { passive: false });
  }
  zoomBy(factor: number): void { this.count = Math.max(10, Math.min(this.bars.length || 200, Math.round(this.count * factor))); this.draw(); }
  private zoom = (event: WheelEvent) => { event.preventDefault(); this.zoomBy(event.deltaY > 0 ? 1.2 : 0.8); };
  update(bars: readonly Bar[], ema: boolean, vwap: boolean, timeframe: Timeframe): void { this.bars = bars; this.ema = ema; this.vwap = vwap; this.timeframe = timeframe; this.draw(); }
  destroy(): void { this.observer.disconnect(); this.canvas.removeEventListener('wheel', this.zoom); }
  private draw(): void {
    const canvas = this.canvas, context = canvas.getContext('2d'); if (!context) return;
    const width = canvas.clientWidth, height = canvas.clientHeight, scale = devicePixelRatio || 1;
    canvas.width = width * scale; canvas.height = height * scale; context.scale(scale, scale); context.clearRect(0, 0, width, height);
    const bars = this.bars.slice(-this.count); if (!bars.length) return;
    const { ema9: ema, ema21, vwap } = computeIndicators([...this.bars]);
    const overlays = [...(this.ema ? [...ema.slice(-bars.length), ...ema21.slice(-bars.length)] : []), ...(this.vwap ? vwap.slice(-bars.length) : [])].filter(Number.isFinite);
    const low = Math.min(...bars.map(bar => bar.l), ...overlays), high = Math.max(...bars.map(bar => bar.h), ...overlays);
    const padding = Math.max(high - low, high * .001, .01) * .12, bottom = low - padding, top = high + padding, range = top - bottom;
    const fontSize = parseFloat(getComputedStyle(canvas).fontSize);
    context.font = `${fontSize}px "DM Sans Variable", sans-serif`;
    const labelWidth = Math.max(...[bottom, top].map(price => context.measureText(money(price)).width)) + 18;
    const left = 8, right = Math.max(30, width - labelWidth), plotTop = fontSize * 2, plotBottom = height - fontSize * 2.75;
    const plotWidth = right - left, y = (price: number) => plotTop + (top - price) / range * (plotBottom - plotTop), step = plotWidth / bars.length;
    context.fillStyle = '#667782'; context.strokeStyle = '#e8edf0'; context.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const price = bottom + range * i / 4; context.beginPath(); context.moveTo(left, y(price)); context.lineTo(right, y(price)); context.stroke(); context.fillText(money(price), right + 10, y(price) + 4); }
    const ticks = Math.min(bars.length, Math.max(2, Math.floor(plotWidth / (fontSize * 8))));
    const daily = this.timeframe === '1Day' || this.timeframe === '1Week';
    for (let i = 0; i < ticks; i++) {
      const index = Math.round(i / Math.max(1, ticks - 1) * (bars.length - 1)), x = left + step * (index + .5);
      context.beginPath(); context.moveTo(x, plotTop); context.lineTo(x, plotBottom + 5); context.stroke();
      context.textAlign = i === 0 ? 'left' : i === ticks - 1 ? 'right' : 'center';
      const crossesDate = exchangeTime(bars[0].t, true) !== exchangeTime(bars.at(-1)!.t, true);
      const label = exchangeTime(bars[index].t, daily || crossesDate && (i === 0 || i === ticks - 1));
      context.fillText(label, x, height - 10);
    }
    context.textAlign = 'left'; context.fillText('USD', right + 10, fontSize + 2);
    context.strokeStyle = '#cdd8de'; context.beginPath(); context.moveTo(left, plotBottom); context.lineTo(right, plotBottom); context.lineTo(right, plotTop); context.stroke();
    context.save(); context.beginPath(); context.rect(left, plotTop, plotWidth, plotBottom - plotTop); context.clip();
    bars.forEach((bar, index) => {
      context.fillStyle = context.strokeStyle = bar.c >= bar.o ? '#087f5b' : '#c83b4d';
      const x = left + step * (index + .5), body = Math.max(2, Math.min(12, step * .6)); context.beginPath(); context.moveTo(x, y(bar.h)); context.lineTo(x, y(bar.l)); context.stroke();
      context.fillRect(x - body / 2, Math.min(y(bar.o), y(bar.c)), body, Math.max(1, Math.abs(y(bar.o) - y(bar.c))));
    });
    const line = (values: number[], color: string) => { context.strokeStyle = color; context.lineWidth = 1.5; context.beginPath(); let started = false; values.slice(-bars.length).forEach((value, i) => { if (Number.isFinite(value)) { if (started) context.lineTo(left + step * (i + .5), y(value)); else context.moveTo(left + step * (i + .5), y(value)); started = true; } else started = false; }); context.stroke(); };
    if (this.ema) { line(ema, '#a4660b'); line(ema21, '#8051b4'); } if (this.vwap) line(vwap, '#2463c2');
    context.restore();
  }
}

export function Chart({ market, symbol }: { market: Market; symbol: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), chart = useRef<CandleCanvas>();
  const [timeframe, setTimeframe] = useState<Timeframe>('5Min'), [ema, setEma] = useState(true), [vwap, setVwap] = useState(false);
  const [bars, setBars] = useState<readonly Bar[]>([]), [error, setError] = useState('Loading chart…');
  const request = useRef(0);
  useEffect(() => { const instance = new CandleCanvas(canvas.current!); chart.current = instance; return () => { instance.destroy(); chart.current = undefined; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), identity = ++request.current;
    setBars([]); setError('Loading chart…');
    let loading = false;
    const refresh = () => {
      if (loading) return;
      loading = true;
      void market.bars(symbol, timeframe, controller.signal).then(values => {
      if (controller.signal.aborted || request.current !== identity) return;
      setBars(values); setError(values.length ? '' : 'No complete bars available.');
      }).catch(error => { if (!controller.signal.aborted && request.current === identity) setError(error instanceof Error ? error.message : 'Chart unavailable.'); }).finally(() => { loading = false; });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { clearInterval(timer); controller.abort(); request.current++; };
  }, [market, symbol, timeframe]);
  useEffect(() => { chart.current?.update(bars, ema, vwap, timeframe); }, [bars, ema, vwap, timeframe]);
  return <section class="panel chart-panel" aria-label={`${symbol} chart`}><div class="toolbar chart-toolbar"><strong>{symbol} <small>Price chart</small></strong>
    <Segmented label="Chart interval" value={timeframe} onChange={setTimeframe} options={intervals} /></div>
    <div class="chart-legend"><div class="indicator-controls" role="group" aria-label="Chart indicators">
      <button type="button" aria-pressed={ema} onClick={() => setEma(!ema)}><i class="legend-line ema" /><i class="legend-line ema-slow" />EMA 9 / 21</button>
      <button type="button" aria-pressed={vwap} onClick={() => setVwap(!vwap)}><i class="legend-line vwap" />VWAP</button></div>
      <div class="zoom-controls"><button type="button" aria-label="Zoom out" onClick={() => chart.current?.zoomBy(1.2)}>−</button><button type="button" aria-label="Zoom in" onClick={() => chart.current?.zoomBy(.8)}>+</button></div></div>
    <div class="chart-stage"><canvas ref={canvas} class="candle-chart" role="img" aria-label={`${symbol} candles, price in USD and time in New York`} data-symbol={symbol} />{error && <p class="chart-message" role="status">{error}</p>}</div>
    <div class="chart-caption"><small>{bars.length > 0 ? <>Last close: {money(bars.at(-1)?.c)}</> : 'Price in USD'}</small><small>{bars.length > 0 && `${exchangeTime(bars.at(-1)!.t, true)} · `}New York time (ET) · Scroll to zoom</small></div></section>;
}
