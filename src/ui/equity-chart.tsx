import { useEffect, useRef, useState } from 'preact/hooks';
import type { PortfolioHistory } from '../core/types';
import { money } from './hooks';

export function EquityChart({ history }: { history: PortfolioHistory }) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(900);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(260, entries[0].contentRect.width)));
    observer.observe(container.current!); return () => observer.disconnect();
  }, []);
  const points = history.equity.map((value, index) => ({ value, time: history.timestamp[index] * 1000 }))
    .filter(point => Number.isFinite(point.value) && Number.isFinite(point.time));
  if (!points.length) return <div ref={container} class="empty-state">Performance unavailable.</div>;
  const height = width < 500 ? 300 : 380, left = 112, right = width - 18, top = 36, bottom = height - 48;
  const minimum = Math.min(...points.map(point => point.value)), maximum = Math.max(...points.map(point => point.value));
  const padding = Math.max(maximum - minimum, maximum * .001, 1) * .15, low = minimum - padding, high = maximum + padding;
  const first = points[0].time, last = points.at(-1)!.time;
  const x = (time: number) => first === last ? (left + right) / 2 : left + (time - first) / (last - first) * (right - left);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const line = points.map(point => `${x(point.time)},${y(point.value)}`).join(' ');
  const tickCount = Math.min(points.length, width < 500 ? 2 : 5);
  const intraday = last - first < 86_400_000;
  const formatTime = (time: number) => new Date(time).toLocaleString('en-US', { timeZone: 'America/New_York',
    ...(intraday ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric', ...(last - first > 365 * 86_400_000 ? { year: '2-digit' } : {}) }),
  });
  return <div ref={container} class="equity-chart-container"><svg class="performance-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Portfolio equity">
    <title>Portfolio equity in US dollars, with dates in New York time</title>
    <defs><linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#087f5b" stop-opacity=".16" /><stop offset="100%" stop-color="#087f5b" stop-opacity=".01" /></linearGradient></defs>
    <text x={left} y={18} class="axis-label">Equity · USD</text>
    {[0, 1, 2, 3, 4].map(tick => {
      const value = low + (high - low) * tick / 4;
      return <g key={tick}><line x1={left} x2={right} y1={y(value)} y2={y(value)} class="chart-gridline" />
        <text x={left - 12} y={y(value) + 4} text-anchor="end" class="axis-label">{value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: high - low < 10 ? 2 : 0 })}</text></g>;
    })}
    <polyline points={`${x(first)},${bottom} ${line} ${x(last)},${bottom}`} fill="url(#equity-fill)" />
    <polyline points={line} fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" />
    <path d={`M${left},${top}V${bottom}H${right}`} class="chart-axis" />
    {Array.from({ length: tickCount }, (_, index) => {
      const point = points[Math.round(index / Math.max(1, tickCount - 1) * (points.length - 1))];
      return <g key={index}><line x1={x(point.time)} x2={x(point.time)} y1={bottom} y2={bottom + 5} class="chart-axis" />
        <text x={x(point.time)} y={bottom + 28} text-anchor={index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle'} class="axis-label">{formatTime(point.time)}</text></g>;
    })}
    <circle cx={x(last)} cy={y(points.at(-1)!.value)} r="4" fill="var(--accent)"><title>{money(points.at(-1)!.value)} · {formatTime(last)}</title></circle>
  </svg></div>;
}
