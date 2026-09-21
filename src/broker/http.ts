import type { Credentials } from '../core/types';
import { BrokerWriteError } from './capabilities';
import type { ApiActivity } from '../core/api-activity';

export class AlpacaRequestError extends BrokerWriteError {
  constructor(message: string, readonly executionUncertain: boolean, readonly retryAfterMs?: number, readonly status?: number) {
    super(message, executionUncertain); this.name = 'AlpacaRequestError';
  }
}
export interface RequestOptions { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal; retries?: number }

/** Shared authentication, normalization and cancellation. Only eligible reads retry. */
export class BrokerTransport {
  private key: string;
  private secret: string;
  private disposed = false;
  private readonly readLifetime = new AbortController();
  private controllers = new Map<AbortController, boolean>();
  constructor(credentials: Credentials, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly activity?: ApiActivity) {
    this.key = credentials.keyId.trim(); this.secret = credentials.secretKey.trim();
    if (!this.key || !this.secret || /[\r\n]/.test(this.key + this.secret)) throw new Error('Valid Alpaca credentials are required.');
  }
  clean(message: string): string {
    for (const credential of [this.key, this.secret]) if (credential) message = message.split(credential).join('[redacted]');
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 260);
  }
  abortReads(): void { this.readLifetime.abort(); for (const [controller, write] of this.controllers) if (!write) controller.abort(); }
  dispose(): void { this.disposed = true; this.abortReads(); for (const controller of this.controllers.keys()) controller.abort(); this.key = ''; this.secret = ''; }
  async request(url: string, options: RequestOptions = {}): Promise<unknown> {
    const write = options.method !== undefined && options.method !== 'GET';
    for (let attempt = 0; ; attempt++) {
      try { return await this.once(url, options, attempt > 0); }
      catch (error) {
        if (write || this.disposed || this.readLifetime.signal.aborted || options.signal?.aborted || !(error instanceof AlpacaRequestError)
          || attempt >= (options.retries ?? 1) || !(error.status === 429 || error.status! >= 500)) throw error;
        const delay = Math.min(30_000, Math.max(1000 * 2 ** attempt, error.retryAfterMs ?? 0));
        await new Promise<void>((resolve, reject) => {
          const clean = () => { options.signal?.removeEventListener('abort', abort); this.readLifetime.signal.removeEventListener('abort', abort); };
          const abort = () => { clearTimeout(timer); clean(); reject(new DOMException('Read cancelled.', 'AbortError')); };
          const timer = setTimeout(() => { clean(); resolve(); }, delay);
          options.signal?.addEventListener('abort', abort, { once: true });
          this.readLifetime.signal.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted || this.readLifetime.signal.aborted) abort();
        });
      }
    }
  }
  private async once(url: string, options: RequestOptions, retry: boolean): Promise<unknown> {
    const method = options.method ?? 'GET', write = method !== 'GET';
    if (this.disposed || !write && (options.signal?.aborted || this.readLifetime.signal.aborted)) throw new DOMException('This connection or read request is closed.', 'AbortError');
    const controller = new AbortController(), abort = () => controller.abort();
    this.controllers.set(controller, write); options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    let response: Response | undefined;
    let failed = false;
    const finish = this.activity?.start(url, method, retry);
    try {
      response = await this.fetcher(url, { method, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { 'APCA-API-KEY-ID': this.key, 'APCA-API-SECRET-KEY': this.secret, Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      if (!write && controller.signal.aborted) throw new DOMException('Read cancelled.', 'AbortError');
      if (!response.ok) {
        const uncertain = write && (response.status === 408 || response.status >= 500);
        const retry = response.headers.get('Retry-After');
        const parsed = retry === null ? NaN : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        const delay = response.status === 429 || !write && response.status >= 500
          ? Number.isFinite(parsed) && parsed >= 0 && parsed <= 3_600_000 ? parsed : response.status === 429 ? 60_000 : undefined : undefined;
        const payload: unknown = await response.json().catch(() => null);
        const detail = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string' ? this.clean(payload.message) : '';
        const reason = response.status === 401 ? 'Authentication failed. Check the keys and selected paper/live account.'
          : response.status === 403 ? 'Access denied. Check account permissions and your market-data feed subscription.'
          : response.status === 429 ? 'Alpaca rate limit reached. Wait before refreshing.'
          : response.status >= 500 ? 'Alpaca is temporarily unavailable.'
          : response.status === 404 ? 'The requested symbol, position, or order was not found.' : `Alpaca rejected the request (${response.status}).`;
        const warning = uncertain ? ' Outcome uncertain. Reconcile orders before any new action.' : '';
        const timedOut = controller.signal.aborted ? ' Response body timed out.' : '';
        throw new AlpacaRequestError(`${reason}${detail && response.status !== 401 ? ` ${detail}` : ''}`.slice(0, 260 - warning.length - timedOut.length) + timedOut + warning, uncertain, delay, response.status);
      }
      if (response.status === 204) return undefined;
      try { return await response.json(); }
      catch { throw new AlpacaRequestError(`Alpaca returned an unreadable response.${write ? ' Check orders; the result may be unknown.' : ''}`, write); }
    } catch (error) {
      failed = true;
      if (error instanceof AlpacaRequestError) throw error;
      if (!write && controller.signal.aborted) throw new DOMException('This connection or read request is closed.', 'AbortError');
      const uncertain = write && (!response || response.ok || response.status === 408 || response.status >= 500);
      const reason = controller.signal.aborted ? 'Alpaca request timed out or was cancelled.' : 'Cannot reach Alpaca. Check your connection or browser cross-origin restrictions.';
      throw new AlpacaRequestError(reason + (uncertain ? ' Outcome uncertain. Reconcile orders before any new action.' : ''), uncertain);
    } finally { finish?.(response?.status, failed, controller.signal.aborted); clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
}
