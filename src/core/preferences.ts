import type { Credentials } from './types';
import type { Vault } from './vault';

export function savedCredentials(vault: Vault): Credentials | null {
  try {
    const value = vault.get('credentials');
    if (!value || typeof value !== 'object') return null;
    const { keyId, secretKey, environment } = value as Partial<Credentials>;
    if (typeof keyId !== 'string' || typeof secretKey !== 'string' || !keyId.trim() || !secretKey.trim()
      || /[\r\n]/.test(keyId + secretKey) || (environment !== 'paper' && environment !== 'live')) return null;
    return { keyId: keyId.trim(), secretKey: secretKey.trim(), environment };
  } catch { return null; }
}

export function saveCredentials(vault: Vault, { keyId, secretKey, environment }: Credentials): Promise<void> {
  return vault.set('credentials', { keyId: keyId.trim(), secretKey: secretKey.trim(), environment });
}

export function forgetCredentials(vault: Vault): Promise<void> { return vault.set('credentials', undefined); }

export function watchlist(vault: Vault): string[] {
  try {
    const value = vault.get('watchlist');
    if (Array.isArray(value) && value.every(symbol => typeof symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))) return [...new Set(value)].slice(0, 100);
  } catch { /* Corrupt preferences reset; execution records never use this path. */ }
  return ['SPY', 'QQQ'];
}
export function saveWatchlist(vault: Vault, symbols: string[]): Promise<void> { return vault.set('watchlist', symbols); }
