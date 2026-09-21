import type { Database } from '../core/database';
import type { DataReads, MarketStream } from '../broker/reads';
import { Scanner, type ScannerSnapshot, type ScannerPreferences } from './service';
import { ScannerCache } from '../market/cache';

export type ReviewChoice = 'monitoring' | 'reviewed' | 'dismissed';
export interface Review { key: string; scope: string; symbol: string; choice: ReviewChoice; at: string }
export interface ScannerModel { snapshot: ScannerSnapshot | null; reviews: readonly Review[]; error: string }
export class ScannerFeature {
  model: ScannerModel = { snapshot: null, reviews: [], error: '' };
  private readonly scanner: Scanner;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly scope: string, private readonly db: Database, reads: DataReads,
    stream: MarketStream, cache: ScannerCache, preferences: ScannerPreferences) {
    this.scanner = new Scanner(stream, () => {
      if (this.disposed) return;
      this.model = { ...this.model, snapshot: { ...this.scanner.snapshot } }; this.publish();
    }, Date.now, { api: reads, cache, preferences });
  }
  async start(): Promise<void> {
    try {
      const rows = await this.db.getAll('reviews');
      const reviews: Review[] = [];
      for (const value of rows) {
        if (!value || typeof value !== 'object' || !('scope' in value) || value.scope !== this.scope) continue;
        if (!('symbol' in value) || typeof value.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(value.symbol)
          || !('choice' in value) || !['monitoring', 'reviewed', 'dismissed'].includes(String(value.choice))
          || !('at' in value) || typeof value.at !== 'string' || !('key' in value) || typeof value.key !== 'string') {
          throw new Error('A saved review is damaged. Other features remain available.');
        }
        reviews.push({ scope: this.scope, symbol: value.symbol, choice: value.choice as ReviewChoice, at: value.at, key: value.key });
      }
      if (this.disposed) return; this.model = { ...this.model, reviews }; this.sync();
    } catch (error) { if (!this.disposed) this.model = { ...this.model, error: error instanceof Error ? error.message : 'Reviews unavailable.' }; }
    if (!this.disposed) { this.scanner.start(); this.publish(); }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private sync(): void { this.scanner.setReviewSymbols(this.model.reviews.filter(review => review.choice === 'monitoring').map(review => review.symbol)); }
  async review(symbol: string, choice: ReviewChoice): Promise<void> {
    if (this.disposed) return;
    const review: Review = { key: JSON.stringify([this.scope, symbol]), scope: this.scope, symbol, choice, at: new Date().toISOString() };
    await this.db.put('reviews', review);
    if (this.disposed) return;
    this.model = { ...this.model, reviews: [...this.model.reviews.filter(value => value.symbol !== symbol), review] };
    this.sync(); this.publish();
  }
  enabled(enabled: boolean): void { this.scanner.updateConfig({ enabled }); }
  dispose(): void { this.disposed = true; this.scanner.dispose(); this.listeners.clear(); }
}
