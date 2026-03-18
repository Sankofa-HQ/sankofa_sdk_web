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

export class SankofaQueueManager {
  private apiKey: string;
  private batchUrl: URL;
  private queue: PersistentQueue<QueuedAnalyticsOperation>;
  private debug: (message: string, ...details: unknown[]) => void;
  private flushInFlight: Promise<void> | null = null;
  private needsAnotherFlush = false;

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

          const response = await fetch(this.batchUrl.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.apiKey,
            },
            body,
            keepalive: Boolean(options.keepalive),
          }).catch((error: unknown) => {
            this.debug("Analytics batch flush failed", error);
            return null;
          });

          if (!response) {
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
