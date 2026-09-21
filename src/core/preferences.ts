import type { Credentials } from './types';

const credentialsKey = 'paca.current.credentials';

export function savedCredentials(): Credentials | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(credentialsKey) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { keyId, secretKey, environment } = value as Partial<Credentials>;
    if (typeof keyId !== 'string' || typeof secretKey !== 'string' || !keyId.trim() || !secretKey.trim()
      || /[\r\n]/.test(keyId + secretKey) || (environment !== 'paper' && environment !== 'live')) return null;
    return { keyId: keyId.trim(), secretKey: secretKey.trim(), environment };
  } catch { return null; }
}

export function saveCredentials({ keyId, secretKey, environment }: Credentials): void {
  localStorage.setItem(credentialsKey, JSON.stringify({ keyId: keyId.trim(), secretKey: secretKey.trim(), environment }));
}

export function forgetCredentials(): void { localStorage.removeItem(credentialsKey); }

export function watchlist(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('paca.current.watchlist') ?? '["SPY","QQQ"]');
    if (Array.isArray(value) && value.every(symbol => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))) return [...new Set(value)].slice(0, 100);
  } catch { /* Corrupt preferences reset; execution records never use this path. */ }
  return ['SPY', 'QQQ'];
}
export function saveWatchlist(symbols: string[]): void { localStorage.setItem('paca.current.watchlist', JSON.stringify(symbols)); }
