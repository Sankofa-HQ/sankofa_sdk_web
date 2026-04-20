import type { FlagDecision } from "./types";

/**
 * One exposure the SDK will forward to POST /api/switch/exposures.
 * Shape matches the server-side `exposureRow` struct exactly — keep
 * them in lockstep if the server contract changes.
 */
interface ExposureRow {
  flag_key: string;
  distinct_id: string;
  anon_id?: string;
  value: boolean;
  variant?: string;
  reason?: string;
  app_version?: string;
  platform?: string;
  sdk?: string;
  ts_ms?: number;
}

export interface ExposureTrackerOptions {
  /** POST url resolved from the browser client's endpoint. */
  endpoint: string;
  /** Project API key — sent in x-api-key. */
  apiKey: string;
  /** Sankofa SDK build identifier (e.g. "sankofa-web-0.1.0"). */
  sdkTag: string;
  /** App version — passed through to experiment reporting. */
  appVersion?: string;
  /** Platform string ("web", "react-native", ...). */
  platform?: string;
  /** Debug logger from the plugin context. */
  debug: (msg: string, ...rest: unknown[]) => void;
  /**
   * Max exposures buffered before the batch flushes. Keeps memory
   * bounded in a long-lived SPA. Batches also flush on a timer and
   * at shutdown.
   */
  batchSize?: number;
  /** Interval between scheduled flushes in ms. */
  flushIntervalMs?: number;
}

/**
 * Tracks per-call flag reads, dedupes them by (session-scope, flag,
 * value+variant), and batches the unique rows to the server's
 * exposure-ingest endpoint.
 *
 * Why dedupe? App code often calls `getFlag('new_checkout')` in a
 * render loop — one user can fire thousands of evaluations per session.
 * Experiment math only cares that the user was *exposed* to a decision,
 * not the raw call count, so the first read per (flag, decision) is
 * the only row we care about. Dedup happens in-memory and resets on
 * client shutdown; cross-session rows re-fire (correctly — a new
 * session is a new exposure).
 *
 * Failure policy mirrors the server's telemetry pump: fire-and-forget,
 * drop-on-full. Exposures are telemetry, never a correctness path —
 * losing a batch to a flaky network must never break the app.
 */
export class ExposureTracker {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly sdkTag: string;
  private readonly appVersion?: string;
  private readonly platform?: string;
  private readonly debug: (msg: string, ...rest: unknown[]) => void;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private buffer: ExposureRow[] = [];
  private seen = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(options: ExposureTrackerOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.sdkTag = options.sdkTag;
    this.appVersion = options.appVersion;
    this.platform = options.platform;
    this.debug = options.debug;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;

    if (typeof setInterval !== "undefined") {
      this.intervalId = setInterval(() => void this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Record a single exposure. Call sites pass the ids alongside the
   * decision because the tracker doesn't own identity — the client
   * snapshot does, and we want the values at the moment of the read,
   * not at flush time (identify() between read and flush would skew
   * attribution otherwise).
   */
  record(params: {
    key: string;
    decision: FlagDecision;
    distinctId: string;
    anonymousId: string;
  }): void {
    if (!params.key || !params.distinctId) return;

    // Dedup scope: (flag, value, variant). A flag flipping mid-session
    // re-fires an exposure with the new decision — which is correct,
    // that *is* a new exposure.
    const dedupKey = `${params.key}|${params.decision.value ? 1 : 0}|${params.decision.variant ?? ""}`;
    if (this.seen.has(dedupKey)) return;
    this.seen.add(dedupKey);

    // Only emit anon_id once identify() has run — pre-identify the
    // anonymous id IS the distinct id, so sending both would be noise.
    const anonId =
      params.anonymousId && params.anonymousId !== params.distinctId
        ? params.anonymousId
        : undefined;

    this.buffer.push({
      flag_key: params.key,
      distinct_id: params.distinctId,
      anon_id: anonId,
      value: params.decision.value,
      variant: params.decision.variant,
      reason: params.decision.reason,
      app_version: this.appVersion,
      platform: this.platform,
      sdk: this.sdkTag,
      ts_ms: Date.now(),
    });

    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Send whatever is in the buffer. Called on timer, on batch-full,
   * and at shutdown. Uses sendBeacon at shutdown when available so
   * the browser doesn't kill the request on pagehide — `fetch` with
   * keepalive is the fallback.
   */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const body = JSON.stringify({ exposures: batch });

    // Shutdown path — prefer sendBeacon, which fires asynchronously
    // without blocking pagehide. The API key has to ride as a query
    // param because beacon doesn't support custom headers.
    if (
      opts.keepalive &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      try {
        const blob = new Blob([body], { type: "application/json" });
        const url = new URL(this.endpoint);
        url.searchParams.set("x-api-key", this.apiKey);
        const ok = navigator.sendBeacon(url.toString(), blob);
        if (!ok) this.debug("exposure beacon dropped");
        return;
      } catch (err) {
        this.debug("exposure beacon threw", err);
      }
    }

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body,
        keepalive: Boolean(opts.keepalive),
      });
    } catch (err) {
      // Network error — drop the batch. Retrying would grow the queue
      // unboundedly on a persistent outage; the dashboard still shows
      // evaluation-based experiment results as a fallback.
      this.debug("exposure flush failed", err);
    }
  }

  /**
   * Called by the plugin's shutdown hook. Flushes any in-flight
   * batch with keepalive so pagehide doesn't strand data.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.flush({ keepalive: true });
  }

  /**
   * Clears the dedup set and drops the pending buffer. Called when
   * identity changes so the identified user gets their own exposures
   * recorded even for flags they already read anonymously — the
   * identified identity IS a different experiment subject until the
   * server-side stitching merges them.
   */
  resetSession(): void {
    this.seen.clear();
    this.buffer = [];
  }
}
