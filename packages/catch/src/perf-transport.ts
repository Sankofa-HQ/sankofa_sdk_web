import type {
  TransactionBatch,
  TransactionWire,
  VitalsBatch,
  WebVitalWire,
} from './types';
import { WireVersionCurrent } from './types';

/**
 * PerfTransport — minimal browser transport for transactions + Web
 * Vitals. Separate from the error Transport because:
 *   - Different endpoints (/transactions, /vitals).
 *   - Vitals are emitted at page-hide, so sendBeacon is the primary
 *     delivery path (survives tab close); the error transport uses
 *     localStorage durability which doesn't fit vitals' semantics.
 *   - Drop-on-full is fine for perf (sampled by design), while errors
 *     require disk durability.
 */
export interface PerfTransportOptions {
  endpoint: string;        // base URL, /api/catch/events or similar — we'll swap the suffix
  apiKey: string;
  batchSize?: number;
  flushIntervalMs?: number;
  debug?: (msg: string, ...rest: unknown[]) => void;
}

const DEFAULT_BATCH = 20;
const DEFAULT_FLUSH_MS = 5_000;

export class PerfTransport {
  private readonly transactionsUrl: string;
  private readonly vitalsUrl: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly debug: (msg: string, ...rest: unknown[]) => void;

  private txnBuf: TransactionWire[] = [];
  private vitalBuf: WebVitalWire[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(opts: PerfTransportOptions) {
    // Derive the perf URLs from the error-events URL so host apps that
    // already pointed the SDK at a custom ingest host don't need a
    // second env var.
    const base = opts.endpoint.replace(/\/api\/catch\/events\/?$/u, '');
    this.transactionsUrl = `${base}/api/catch/transactions`;
    this.vitalsUrl = `${base}/api/catch/vitals`;
    this.apiKey = opts.apiKey;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.debug = opts.debug ?? (() => {});

    this.intervalId = setInterval(() => void this.flush(), this.flushIntervalMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  postTransactions(items: TransactionWire[]): void {
    if (this.shuttingDown) return;
    this.txnBuf.push(...items);
    if (this.txnBuf.length >= this.batchSize) void this.flushTransactions();
  }

  postVitals(items: WebVitalWire[]): void {
    if (this.shuttingDown) return;
    this.vitalBuf.push(...items);
    // Vitals are lighter; flush on every emission is fine but we still
    // batch within a microtask to avoid N serial network writes.
    if (this.vitalBuf.length >= this.batchSize) void this.flushVitals();
  }

  async flush(): Promise<void> {
    await Promise.all([this.flushTransactions(), this.flushVitals()]);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    // Last-chance beacon flush.
    this.beaconFlushAll();
  }

  private onPageHide = (): void => {
    this.beaconFlushAll();
  };

  private onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.beaconFlushAll();
    }
  };

  private beaconFlushAll(): void {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      void this.flush();
      return;
    }
    if (this.txnBuf.length > 0) {
      const batch: TransactionBatch = {
        wire_version: WireVersionCurrent,
        transactions: this.txnBuf.splice(0, this.txnBuf.length),
      };
      try {
        navigator.sendBeacon(
          this.transactionsUrl,
          new Blob([JSON.stringify(batch)], { type: 'application/json' }),
        );
      } catch (err) {
        this.debug('beacon txn failed', err);
      }
    }
    if (this.vitalBuf.length > 0) {
      const batch: VitalsBatch = {
        wire_version: WireVersionCurrent,
        vitals: this.vitalBuf.splice(0, this.vitalBuf.length),
      };
      try {
        navigator.sendBeacon(
          this.vitalsUrl,
          new Blob([JSON.stringify(batch)], { type: 'application/json' }),
        );
      } catch (err) {
        this.debug('beacon vitals failed', err);
      }
    }
  }

  private async flushTransactions(): Promise<void> {
    if (this.txnBuf.length === 0) return;
    const batch: TransactionBatch = {
      wire_version: WireVersionCurrent,
      transactions: this.txnBuf.splice(0, this.txnBuf.length),
    };
    await this.postJson(this.transactionsUrl, batch);
  }

  private async flushVitals(): Promise<void> {
    if (this.vitalBuf.length === 0) return;
    const batch: VitalsBatch = {
      wire_version: WireVersionCurrent,
      vitals: this.vitalBuf.splice(0, this.vitalBuf.length),
    };
    await this.postJson(this.vitalsUrl, batch);
  }

  private async postJson(url: string, payload: unknown): Promise<void> {
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (err) {
      this.debug('perf POST failed (dropping):', err);
      // Drop on failure — perf is sampled.
    }
  }
}
