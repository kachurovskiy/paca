export type AlpacaApiKind = 'trading' | 'market-data';
export interface ApiCallGroup {
  api: AlpacaApiKind; method: string; endpoint: string; count: number; retries: number;
  pending: number; failed: number; statuses: Record<string, number>; totalDurationMs: number; completed: number;
}
export interface ApiActivitySnapshot { trading: number; marketData: number; since: number; at: number; groups: ApiCallGroup[] }
interface Attempt { at: number; api: AlpacaApiKind; method: string; endpoint: string; retry: boolean; status: string; duration: number | null; failed: boolean }

/** Connection-local, rolling HTTP attempts. Never records credentials, bodies or identifiers. */
export class ApiActivity {
  private attempts: Attempt[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  start(url: string, method: string, retry: boolean): (status: number | undefined, failed: boolean, aborted: boolean) => void {
    const parsed = new URL(url);
    const api = parsed.hostname === 'data.alpaca.markets' ? 'market-data'
      : ['api.alpaca.markets', 'paper-api.alpaca.markets'].includes(parsed.hostname) ? 'trading' : null;
    if (!api) return () => {};
    // Group variable IDs/symbols and changing time/page cursors into their endpoint.
    const path = parsed.pathname.replace(/(\/v2\/orders\/)[^/]+$/, '$1:id').replace(/(\/v2\/stocks\/)[^/]+(\/bars)$/, '$1:symbol$2');
    const query = new URLSearchParams();
    for (const name of ['feed', 'timeframe', 'status', 'nested', 'period', 'adjustment'] as const) {
      const value = parsed.searchParams.get(name);
      if (value && /^[a-zA-Z0-9_-]{1,24}$/.test(value)) query.set(name, value);
    }
    const at = this.now(); this.prune(at);
    const attempt: Attempt = { at, api, method, endpoint: path + (query.size ? `?${query}` : ''), retry, status: 'Pending', duration: null, failed: false };
    this.attempts.push(attempt);
    return (status, failed, aborted) => {
      attempt.status = status === undefined ? aborted ? 'Cancelled' : 'Network error' : String(status);
      attempt.duration = Math.max(0, this.now() - at); attempt.failed = failed;
    };
  }
  snapshot(): ApiActivitySnapshot {
    const at = this.now(); this.prune(at);
    const groups = new Map<string, ApiCallGroup>();
    let trading = 0, marketData = 0;
    for (const call of this.attempts) {
      if (call.api === 'trading') trading++; else marketData++;
      const key = `${call.api}:${call.method}:${call.endpoint}`;
      let group = groups.get(key);
      if (!group) { group = { api: call.api, method: call.method, endpoint: call.endpoint, count: 0, retries: 0, pending: 0, failed: 0, statuses: {}, totalDurationMs: 0, completed: 0 }; groups.set(key, group); }
      group.count++; group.retries += Number(call.retry); group.failed += Number(call.failed);
      group.statuses[call.status] = (group.statuses[call.status] ?? 0) + 1;
      if (call.duration === null) group.pending++; else { group.completed++; group.totalDurationMs += call.duration; }
    }
    return { trading, marketData, since: at - 60_000, at, groups: [...groups.values()].sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint) || a.method.localeCompare(b.method)) };
  }
  private prune(at: number): void { this.attempts = this.attempts.filter(call => call.at > at - 60_000 && call.at <= at); }
}
