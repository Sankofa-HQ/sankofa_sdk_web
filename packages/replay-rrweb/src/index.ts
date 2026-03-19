import { createPersistentQueue, type SankofaClientSnapshot, type SankofaFlushOptions, type SankofaPlugin, type SankofaPluginContext } from "@sankofa/browser";
import { SANKOFA_BROWSER_VERSION } from "@sankofa/browser";
import { gzip } from "pako";
import { record } from "rrweb";
import type { eventWithTime } from "rrweb";

type QueuedReplayChunk = {
  sessionId: string;
  distinctId: string;
  chunkIndex: number;
  replayMode: "rrweb";
  eventCount: number;
  startedAt: string;
  endedAt: string;
  payload: Uint8Array;
};

export interface RrwebReplayPluginOptions {
  enabled?: boolean;
  flushIntervalMs?: number;
  maxEventsPerChunk?: number;
  maskAllInputs?: boolean;
  blockSelector?: string;
  maskSelector?: string;
  ignoreSelector?: string;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    RrwebReplayPluginOptions,
    "enabled" | "flushIntervalMs" | "maxEventsPerChunk" | "maskAllInputs"
  >
> = {
  enabled: true,
  flushIntervalMs: 5_000,
  maxEventsPerChunk: 250,
  maskAllInputs: true,
};

export function rrwebReplayPlugin(
  options: RrwebReplayPluginOptions = {},
): SankofaPlugin {
  return {
    name: "rrweb-replay",
    setup(context: SankofaPluginContext) {
      const remoteConfig = (context as any).replayConfig as any;
      const config = {
        ...DEFAULT_OPTIONS,
        ...options,
        // Override with remote config if available
        enabled: remoteConfig ? remoteConfig.enabled : (options.enabled ?? DEFAULT_OPTIONS.enabled),
        maskAllInputs: remoteConfig ? remoteConfig.mask_all_inputs : (options.maskAllInputs ?? DEFAULT_OPTIONS.maskAllInputs),
      };

      // Initial Sampling
      const isSampledIn = remoteConfig ? Math.random() < remoteConfig.sample_rate : true;
      let isForcedHighFidelity = false;

      if (!config.enabled || typeof window === "undefined") {
        return {};
      }

      let snapshot = context.getSnapshot();
      let buffer: eventWithTime[] = [];
      let bufferSessionId: string | null = null;
      let bufferDistinctId: string | null = null;
      let chunkIndex = 0;
      let chunkStartedAt: number | null = null;
      let stopRecording: (() => void) | undefined;
      let flushTimer: number | null = null;

      const stopAndCleanup = () => {
        if (flushTimer !== null) {
          window.clearInterval(flushTimer);
          flushTimer = null;
        }
        stopRecording?.();
        stopRecording = undefined;
      };

      const startRecording = () => {
        if (stopRecording) return;
        
        stopRecording = record({
          emit(event) {
            if (buffer.length === 0) {
              snapshot = context.getSnapshot();
              bufferSessionId = snapshot.sessionId;
              bufferDistinctId = snapshot.distinctId;
              chunkStartedAt = event.timestamp;
            }

            buffer.push(event);
            if (buffer.length >= config.maxEventsPerChunk) {
              void flushBufferedChunk({
                reason: "buffer",
              });
            }
          },
          maskAllInputs: config.maskAllInputs,
          blockSelector: options.blockSelector,
          maskTextSelector: options.maskSelector,
          ignoreSelector: options.ignoreSelector,
        });

        if (flushTimer === null) {
          flushTimer = window.setInterval(() => {
            void flushBufferedChunk({
              reason: "timer",
            });
          }, config.flushIntervalMs);
        }
      };

      const queue = createPersistentQueue<QueuedReplayChunk>({
        dbName: `${snapshot.projectNamespace}:replay`,
        storeName: "chunks",
      });

      const flushBufferedChunk = async (flushOptions?: SankofaFlushOptions) => {
        if (buffer.length === 0 || chunkStartedAt === null) {
          return;
        }

        const events = buffer;
        const startedAt = chunkStartedAt;
        const endedAt = events[events.length - 1]?.timestamp ?? Date.now();
        const currentChunkIndex = chunkIndex;
        const sessionId = bufferSessionId ?? snapshot.sessionId;
        const distinctId = bufferDistinctId ?? snapshot.distinctId;

        buffer = [];
        bufferSessionId = null;
        bufferDistinctId = null;
        chunkStartedAt = null;
        chunkIndex += 1;

        const body = {
          mode: "rrweb" as const,
          session_id: sessionId,
          distinct_id: distinctId,
          chunk_index: currentChunkIndex,
          started_at: new Date(startedAt).toISOString(),
          ended_at: new Date(endedAt).toISOString(),
          event_count: events.length,
          events,
          meta: {
            url: window.location.href,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
            sdk_version: SANKOFA_BROWSER_VERSION,
          },
        };

        await queue.add({
          sessionId,
          distinctId,
          chunkIndex: currentChunkIndex,
          replayMode: "rrweb",
          eventCount: events.length,
          startedAt: body.started_at,
          endedAt: body.ended_at,
          payload: gzip(JSON.stringify(body)),
        });

        await flushPersistedChunks(flushOptions);
      };

      const flushPersistedChunks = async (flushOptions?: SankofaFlushOptions) => {
        const queued = await queue.getAll(10);
        for (const chunk of queued) {
          const payload = Uint8Array.from(chunk.value.payload);
          const response = await fetch(snapshot.replayChunkUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "x-api-key": snapshot.apiKey,
              "X-Session-Id": chunk.value.sessionId,
              "X-Chunk-Index": String(chunk.value.chunkIndex),
              "X-Distinct-Id": chunk.value.distinctId,
              "X-Replay-Mode": chunk.value.replayMode,
            },
            body: payload,
            keepalive: Boolean(flushOptions?.keepalive),
          }).catch((error: unknown) => {
            context.debug("Replay upload failed", error);
            return null;
          });

          if (!response) {
            break;
          }

          if (!response.ok) {
            context.debug(
              `Replay upload failed with ${response.status} ${response.statusText}`,
              {
                url: snapshot.replayChunkUrl,
                chunkIndex: chunk.value.chunkIndex,
              },
            );
            break;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const ack = await response.clone().json().catch(() => null);
            if (ack) {
              context.debug("Replay chunk uploaded", ack);
            }
          }

          await queue.deleteMany([chunk.id]);
        }
      };

      if (isSampledIn) {
        startRecording();
      }

      return {
        async flush(flushOptions?: SankofaFlushOptions) {
          await flushBufferedChunk(flushOptions);
          await flushPersistedChunks(flushOptions);
        },
        async shutdown() {
          if (flushTimer !== null) {
            window.clearInterval(flushTimer);
          }
          stopRecording?.();
          await flushBufferedChunk({
            reason: "shutdown",
          });
          await flushPersistedChunks({
            reason: "shutdown",
          });
        },
        async onDistinctIdChange(current: SankofaClientSnapshot) {
          const previousSnapshot = snapshot;
          snapshot = previousSnapshot;
          await flushBufferedChunk({
            reason: "plugin",
          });
          snapshot = current;
        },
        async onSessionChange(current: SankofaClientSnapshot, previous: SankofaClientSnapshot) {
          snapshot = previous;
          await flushBufferedChunk({
            reason: "plugin",
          });
          snapshot = current;
          chunkIndex = 0;
          
          // Re-evaluate sampling for new session
          if (!isForcedHighFidelity) {
              const sampled = remoteConfig ? Math.random() < remoteConfig.sample_rate : true;
              if (sampled) {
                  startRecording();
              } else {
                  stopAndCleanup();
              }
          }
        },
        async onHighFidelity() {
          context.debug("Plugin triggered High Fidelity Mode");
          isForcedHighFidelity = true;
          startRecording();
          
          // In rrweb, "High Fidelity" mostly means "Definitely Record".
          // We could also potentially change sampling rates or capture mouse interactions 
          // more aggressively if they were disabled, but for now, we just ensure it's ON.
          
          if (remoteConfig?.high_fidelity_duration_seconds) {
              window.setTimeout(() => {
                  isForcedHighFidelity = false;
                  // If we weren't sampled in, stop recording after the burst
                  if (!isSampledIn) {
                      stopAndCleanup();
                  }
              }, remoteConfig.high_fidelity_duration_seconds * 1000);
          }
        },
      };
    },
  };
}
