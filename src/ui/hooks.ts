import { useEffect, useState } from 'preact/hooks';

/** Subscribe to one stable feature service. Input/selection state stays in views. */
export function useFeature<T>(service: { readonly model: T; subscribe(listener: () => void): () => void }): T {
  const [model, setModel] = useState(service.model);
  useEffect(() => { setModel(service.model); return service.subscribe(() => setModel(service.model)); }, [service]);
  return model;
}
export const money = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? '—'
  : value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
export const number = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
export function download(name: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
