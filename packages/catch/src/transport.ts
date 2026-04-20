import type { CatchBatch, CatchEvent } from './types';
import { WireVersionCurrent } from './types';

/**
 * Transport — batches CatchEvents and POSTs them to /api/catch/events.
 *
 * Design:
 *   - Hold events in memory up to `batchSize` (default 20).
 *   - Flush on:
 *       - batch full
 *       - flush interval tick (every 5s)
 *       - manual .flush()
 *       - page unload (sendBeacon path)
 *   - Persist unflushed events to localStorage on every push so a
 *     tab close mid-batch doesn't lose them. The queue is drained on
 *     SDK init after the cache reads.
 *   - Drop-on-full — if localStorage grows past the cap (default
 *     512 KB, ~1000 events), oldest items are dropped first.
 */

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  storagePrefix: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxStorageBytes?: number;
  debug?: (msg: string, ...rest: unknown[]) => void;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_STORAGE_BYTES = 512 * 1024;

export class Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly storageKey: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxStorageBytes: number;
  private readonly debug: (msg: string, ...rest: unknown[]) => void;

  private buffer: CatchEvent[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private unloadHandler: (() => void) | null = null;

  constructor(opts: TransportOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.storageKey = `${opts.storagePrefix}:catch:queue`;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxStorageBytes = opts.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    this.debug = opts.debug ?? (() => {});

    // Recover anything the previous session failed to flush.
    this.recoverPersistedQueue();

    // Periodic flusher.
    if (typeof setInterval !== 'undefined') {
      this.intervalId = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }

    // Page unload — sendBeacon path so nothing is lost at tab close.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.unloadHandler = () => {
        void this.flush({ keepalive: true });
      };
      window.addEventListener('pagehide', this.unloadHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

  /** Enqueue an event. Triggers a flush when the batch fills. */
  push(event: CatchEvent): void {
    this.buffer.push(event);
    this.persist();
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Force-flush everything pending. Resolves when the POST returns. */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch: CatchBatch = {
      wire_version: WireVersionCurrent,
      events: this.buffer.splice(0, this.buffer.length),
    };
    this.persist();

    const body = JSON.stringify(batch);

    // Shutdown path — beacon when available; otherwise keepalive fetch.
    if (
      opts.keepalive &&
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      try {
        const url = new URL(this.endpoint);
        url.searchParams.set('x-api-key', this.apiKey);
        const ok = navigator.sendBeacon(url.toString(), new Blob([body], { type: 'application/json' }));
        if (!ok) {
          this.debug('catch beacon dropped — requeuing batch');
          this.buffer.unshift(...batch.events);
          this.persist();
        }
        return;
      } catch (err) {
        this.debug('catch beacon threw', err);
      }
    }

    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body,
        keepalive: Boolean(opts.keepalive),
      });
    } catch (err) {
      // Network error — requeue so the next flush tries again. This
      // bounded by the storage cap so a persistent outage can't grow
      // the queue unboundedly.
      this.debug('catch flush failed — requeuing', err);
      this.buffer.unshift(...batch.events);
      this.persist();
    }
  }

  /** Tear down timers and window handlers. */
  shutdown(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    // Best-effort final flush with keepalive so in-flight events land.
    void this.flush({ keepalive: true });
  }

  // ── Persistence ─────────────────────────────────────────────────

  private persist(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      // Cap: while the serialised buffer exceeds the budget, drop
      // oldest entries. Better to lose the oldest crumbs than blow
      // up localStorage.
      let serialised = JSON.stringify(this.buffer);
      while (serialised.length > this.maxStorageBytes && this.buffer.length > 1) {
        this.buffer.shift();
        serialised = JSON.stringify(this.buffer);
      }
      window.localStorage.setItem(this.storageKey, serialised);
    } catch {
      /* private mode / storage-full — continue without persistence */
    }
  }

  private recoverPersistedQueue(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.buffer = parsed as CatchEvent[];
        this.debug(`catch: recovered ${this.buffer.length} persisted events`);
      }
    } catch {
      // Corrupted blob — nuke it.
      try {
        window.localStorage.removeItem(this.storageKey);
      } catch {
        /* ignore */
      }
    }
  }
}
