import { createPersistentQueue } from "./storage";
import type {
  PersistentQueue,
  SankofaAliasPayload,
  SankofaBatchOperation,
  SankofaFlushOptions,
  SankofaPeoplePayload,
  SankofaTrackPayload,
} from "./types";

const MAX_BATCH_SIZE = 100;

export type QueuedAnalyticsOperation = {
  type: SankofaBatchOperation["type"];
  payload: SankofaTrackPayload | SankofaPeoplePayload | SankofaAliasPayload;
  queuedAt: string;
};

export type TransportFailureKind =
  | "network"
  | "http_error"
  | "cors"
  | "timeout"
  | "unknown";

export interface TransportStatus {
  /** ms since epoch of the last completed flush attempt, or null if none. */
  lastAttemptAt: number | null;
  /** Outcome of the last attempt. null = never attempted. */
  lastResult: "ok" | "error" | null;
  /** HTTP status from the last attempt (when the request reached the server). */
  lastStatus: number | null;
  /** Best-effort classification of the last error. */
  lastFailureKind: TransportFailureKind | null;
  /** Human-readable error message from the last attempt, if any. */
  lastError: string | null;
  /** Total number of operations sent successfully across this session. */
  successfulOperations: number;
  /** Total flush attempts that ended in error. */
  failedAttempts: number;
  /** Total flush attempts that ended successfully. */
  successfulAttempts: number;
  /** Resolved batch URL for reference. */
  batchUrl: string;
}

export type TransportListener = (status: TransportStatus) => void;

export class SankofaQueueManager {
  private apiKey: string;
  private batchUrl: URL;
  private queue: PersistentQueue<QueuedAnalyticsOperation>;
  private debug: (message: string, ...details: unknown[]) => void;
  private flushInFlight: Promise<void> | null = null;
  private needsAnotherFlush = false;
  private status: TransportStatus;
  private listeners = new Set<TransportListener>();

  constructor(options: {
    apiKey: string;
    batchUrl: URL;
    storagePrefix: string;
    debug: (message: string, ...details: unknown[]) => void;
  }) {
    this.apiKey = options.apiKey;
    this.batchUrl = options.batchUrl;
    this.debug = options.debug;
    this.queue = createPersistentQueue<QueuedAnalyticsOperation>({
      dbName: `${options.storagePrefix}:analytics`,
      storeName: "operations",
    });
    this.status = {
      lastAttemptAt: null,
      lastResult: null,
      lastStatus: null,
      lastFailureKind: null,
      lastError: null,
      successfulOperations: 0,
      failedAttempts: 0,
      successfulAttempts: 0,
      batchUrl: this.batchUrl.toString(),
    };
  }

  getStatus(): TransportStatus {
    return { ...this.status };
  }

  onStatusChange(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateStatus(patch: Partial<TransportStatus>): void {
    this.status = { ...this.status, ...patch };
    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.debug("transport listener threw", err);
      }
    }
  }

  async enqueue(operation: SankofaBatchOperation): Promise<void> {
    await this.queue.add({
      type: operation.type,
      payload: operation.payload,
      queuedAt: new Date().toISOString(),
    });
  }

  async flush(options: SankofaFlushOptions = {}): Promise<void> {
    if (this.flushInFlight) {
      this.needsAnotherFlush = true;
      return this.flushInFlight;
    }

    this.flushInFlight = (async () => {
      do {
        this.needsAnotherFlush = false;

        let rows = await this.queue.getAll(MAX_BATCH_SIZE);
        while (rows.length > 0) {
          const body = JSON.stringify({
            operations: rows.map((row) => ({
              type: row.value.type,
              payload: row.value.payload,
            })),
          });

          let networkError: unknown = null;
          const response = await fetch(this.batchUrl.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.apiKey,
            },
            body,
            keepalive: Boolean(options.keepalive),
          }).catch((error: unknown) => {
            networkError = error;
            this.debug("Analytics batch flush failed", error);
            return null;
          });

          if (!response) {
            // No response — DNS / CORS / offline / refused. Browsers
            // surface CORS as a generic TypeError, so we classify here
            // best-effort and let the host UI render a precise hint.
            const message =
              networkError instanceof Error
                ? networkError.message
                : String(networkError ?? "network error");
            const kind: TransportFailureKind = /cors|cross[- ]origin/i.test(message)
              ? "cors"
              : /abort|timeout/i.test(message)
                ? "timeout"
                : "network";
            this.updateStatus({
              lastAttemptAt: Date.now(),
              lastResult: "error",
              lastStatus: null,
              lastFailureKind: kind,
              lastError: message,
              failedAttempts: this.status.failedAttempts + 1,
            });
            break;
          }

          if (!response.ok) {
            this.debug(
              `Analytics batch flush failed with ${response.status} ${response.statusText}`,
              {
                reason: options.reason ?? "unknown",
                url: this.batchUrl.toString(),
              },
            );
            this.updateStatus({
              lastAttemptAt: Date.now(),
              lastResult: "error",
              lastStatus: response.status,
              lastFailureKind: "http_error",
              lastError: `${response.status} ${response.statusText || "request failed"}`,
              failedAttempts: this.status.failedAttempts + 1,
            });
            break;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const ack = await response.clone().json().catch(() => null);
            if (ack) {
              this.debug("Analytics batch flushed", ack);
            }
          }

          await this.queue.deleteMany(rows.map((row) => row.id));
          this.updateStatus({
            lastAttemptAt: Date.now(),
            lastResult: "ok",
            lastStatus: response.status,
            lastFailureKind: null,
            lastError: null,
            successfulOperations: this.status.successfulOperations + rows.length,
            successfulAttempts: this.status.successfulAttempts + 1,
          });
          rows = await this.queue.getAll(MAX_BATCH_SIZE);
        }
      } while (this.needsAnotherFlush);
    })();

    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  async count(): Promise<number> {
    return this.queue.count();
  }
}
