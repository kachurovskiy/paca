import type { ComponentChildren } from 'preact';
import { money } from './hooks';

/** Native buttons keep every choice one click away, with keyboard and pressed-state support. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled = false, className = '' }: {
  label: string; value: T; options: readonly { value: T; label: string }[];
  onChange: (value: T) => void; disabled?: boolean; className?: string;
}) {
  return <div class={`segmented ${className}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" disabled={disabled}
      aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function Pnl({ value }: { value: number | null | undefined }) {
  const valid = value != null && Number.isFinite(value);
  return <span class={`pnl ${valid && value > 0 ? 'positive' : valid && value < 0 ? 'negative' : 'neutral'}`}>
    {valid && value > 0 ? '+' : ''}{money(value)}
  </span>;
}

export function EmptyRow({ columns, children }: { columns: number; children: ComponentChildren }) {
  return <tr><td colSpan={columns} class="empty-state">{children}</td></tr>;
}

export function TablePanel({ title, children, className = '' }: { title: string; children: ComponentChildren; className?: string }) {
  return <section class={`panel table-panel ${className}`} aria-label={title}><h2>{title}</h2>
    <div class="table-scroll" tabIndex={0} role="region" aria-label={`${title} table`}>{children}</div></section>;
}

export function Timestamp({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{value}</span>;
  return <time dateTime={value} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
    <small class="cell-detail">{date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</small></time>;
}
