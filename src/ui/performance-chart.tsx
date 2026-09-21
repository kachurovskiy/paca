import { useEffect, useRef, useState } from 'preact/hooks';
import type { PortfolioHistory } from '../core/types';
import { money } from './hooks';

export type PerformanceMetric = 'pnl' | 'equity';

export function PerformanceChart({ history, metric }: { history: PortfolioHistory; metric: PerformanceMetric }) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(900);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(260, entries[0].contentRect.width)));
    observer.observe(container.current!); return () => observer.disconnect();
  }, []);
  const profit = metric === 'pnl';
  const points = (profit ? history.profitLoss : history.equity).map((value, index) => ({ value, time: history.timestamp[index] * 1000 }))
    .filter(point => Number.isFinite(point.value) && Number.isFinite(point.time));
  if (!points.length) return <div ref={container} class="empty-state">Performance unavailable.</div>;
  const height = width < 500 ? 300 : 380, left = 112, right = width - 18, top = 36, bottom = height - 48;
  const minimum = Math.min(...points.map(point => point.value), profit ? 0 : Infinity), maximum = Math.max(...points.map(point => point.value), profit ? 0 : -Infinity);
  const padding = Math.max(maximum - minimum, Math.abs(maximum) * .001, 1) * .15, low = minimum - padding, high = maximum + padding;
  const first = points[0].time, last = points.at(-1)!.time;
  const x = (time: number) => first === last ? (left + right) / 2 : left + (time - first) / (last - first) * (right - left);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const line = points.map(point => `${x(point.time)},${y(point.value)}`).join(' ');
  const color = profit && points.at(-1)!.value < 0 ? 'var(--negative)' : 'var(--accent)', baseline = profit ? y(0) : bottom;
  const name = profit ? 'Portfolio P/L excluding cash transfers' : 'Portfolio equity', gradient = `performance-${metric}-fill`;
  const tickCount = Math.min(points.length, width < 500 ? 2 : 5);
  const intraday = last - first < 86_400_000;
  const formatTime = (time: number) => new Date(time).toLocaleString('en-US', { timeZone: 'America/New_York',
    ...(intraday ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric', ...(last - first > 365 * 86_400_000 ? { year: '2-digit' } : {}) }),
  });
  return <div ref={container} class="performance-chart-container"><svg class="performance-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={name}>
    <title>{name} in US dollars, with dates in New York time</title>
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color={color} stop-opacity=".16" /><stop offset="100%" stop-color={color} stop-opacity=".01" /></linearGradient></defs>
    <text x={left} y={18} class="axis-label">{profit ? 'P/L' : 'Equity'} · USD</text>
    {[0, 1, 2, 3, 4].map(tick => {
      const value = low + (high - low) * tick / 4;
      return <g key={tick}><line x1={left} x2={right} y1={y(value)} y2={y(value)} class="chart-gridline" />
        <text x={left - 12} y={y(value) + 4} text-anchor="end" class="axis-label">{value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: high - low < 10 ? 2 : 0 })}</text></g>;
    })}
    <polyline points={`${x(first)},${baseline} ${line} ${x(last)},${baseline}`} fill={`url(#${gradient})`} />
    {profit && <g><line x1={left} x2={right} y1={baseline} y2={baseline} class="chart-zero-line"><title>Break-even · $0.00</title></line>
      <text x={right} y={baseline - 7} text-anchor="end" class="axis-label">$0</text></g>}
    <polyline class="performance-series" points={line} fill="none" stroke={color} stroke-width="2.5" stroke-linejoin="round" />
    <path d={`M${left},${top}V${bottom}H${right}`} class="chart-axis" />
    {Array.from({ length: tickCount }, (_, index) => {
      const point = points[Math.round(index / Math.max(1, tickCount - 1) * (points.length - 1))];
      return <g key={index}><line x1={x(point.time)} x2={x(point.time)} y1={bottom} y2={bottom + 5} class="chart-axis" />
        <text x={x(point.time)} y={bottom + 28} text-anchor={index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle'} class="axis-label">{formatTime(point.time)}</text></g>;
    })}
    <circle cx={x(last)} cy={y(points.at(-1)!.value)} r="4" fill={color}><title>{money(points.at(-1)!.value)} · {formatTime(last)}</title></circle>
  </svg></div>;
}
