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

// ─── Heatmap interaction encoding ─────────────────────────────────────────────
// The Sankofa backend (server/engine/ee/replay/worker.go) reads payload.events[]
// from each replay chunk and inserts any event whose data.source ∈ {1,2,3,5,6}
// into the `replay_interactions` ClickHouse table.  It then normalizes (x,y) by
// dividing by device_context.{screen_width,screen_height} to produce 0.0–1.0
// coordinates that the dashboard renders as heatmap dots.
//
// The iOS SDK uses source=2 (mobile tap) and the same wire shape, so we mirror
// it exactly here for full backend parity — no server changes required.
const RRWEB_INCREMENTAL_SNAPSHOT = 3;
const HEATMAP_SOURCE_TAP = 2;
const TAP_TYPE_DOWN = 1;
const TAP_TYPE_UP = 0;
const TAP_TYPE_MOVE = 6;
// Synthetic marker emitted by the SDK when a click is the second of a
// double-click sequence.  Matches rrweb's official `dblclick` enum value (4)
// so the rrweb player can replay it natively.  The dashboard reads
// interaction_type = 4 to render a "2×" overlay icon at the click site.
const TAP_TYPE_DOUBLE = 4;
// Double-click recognition window — matches macOS / Windows defaults
// closely.  Anything slower than this is treated as two separate clicks.
const DOUBLE_CLICK_INTERVAL_MS = 350;
// Spatial tolerance — a click that lands within this many pixels of the
// previous click and inside the time window counts as a double-click.
const DOUBLE_CLICK_RADIUS_PX = 25;

interface HeatmapInteractionEvent {
  type: typeof RRWEB_INCREMENTAL_SNAPSHOT;
  data: {
    source: typeof HEATMAP_SOURCE_TAP;
    type: number;
    id: number;
    x: number;
    y: number;
    /**
     * Stable CSS selector of the click target.  Used by the dashboard's
     * "Top Clicked Elements" panel for accurate element attribution.
     * Mirrors the same algorithm in dashboard/ee/components/heatmaps/web/stableSelector.ts.
     */
    selector?: string;
    /**
     * Document dimensions sampled at click time.  The chunk-level
     * device_context.{document_width,document_height} only reflects the
     * page size at flush time — for dynamic pages (lazy images, modals,
     * infinite scroll) the natural page can grow significantly between
     * the click and the flush, which would shift the click's normalized
     * Y away from the element it actually hit.  Capturing per-event
     * lets the worker normalize each click against the page as it
     * existed when the user clicked.
     *
     * Names are abbreviated (`dw` / `dh`) to keep the per-event payload
     * tight — at 20 samples/sec for pointermove these add up.
     */
    dw?: number;
    dh?: number;
  };
  timestamp: number;
  screen?: string;
}

/**
 * Computes a short, stable CSS selector for an element.  Mirrors the
 * dashboard implementation at dashboard/ee/components/heatmaps/web/stableSelector.ts —
 * keep both copies in sync if you change the priority order.
 *
 * Priority:
 *   1. data-testid attribute  (most stable)
 *   2. id attribute
 *   3. role + tag
 *   4. tag.class
 *   5. tag (last resort)
 */
function stableSelectorFor(el: Element | null): string {
  if (!el) return "";
  const tid = el.getAttribute("data-testid");
  if (tid) return `[data-testid="${tid}"]`;
  if (el.id) return `#${el.id}`;
  const role = el.getAttribute("role");
  if (role) return `${el.tagName.toLowerCase()}[role="${role}"]`;
  const className =
    typeof el.className === "string"
      ? el.className
      : ((el as unknown as { className?: { baseVal?: string } }).className
          ?.baseVal ?? "");
  const classes = className
    .split(" ")
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(".");
  return classes
    ? `${el.tagName.toLowerCase()}.${classes}`
    : el.tagName.toLowerCase();
}

export interface RrwebReplayPluginOptions {
  enabled?: boolean;
  flushIntervalMs?: number;
  maxEventsPerChunk?: number;
  maskAllInputs?: boolean;
  blockSelector?: string;
  maskSelector?: string;
  ignoreSelector?: string;
  /**
   * When `true` (default), the plugin captures click/pointer events and injects
   * them as rrweb CustomEvents into the chunk so the dashboard can render web
   * heatmaps.  Disable only if you are forwarding heatmap data through some
   * other mechanism.
   */
  captureHeatmap?: boolean;
  /**
   * Throttle for `pointermove` capture (ms).  Defaults to 50ms (~20 samples/sec).
   * Down/up are never throttled.
   */
  pointerMoveThrottleMs?: number;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    RrwebReplayPluginOptions,
    "enabled" | "flushIntervalMs" | "maxEventsPerChunk" | "maskAllInputs" | "captureHeatmap" | "pointerMoveThrottleMs"
  >
> = {
  enabled: true,
  flushIntervalMs: 5_000,
  maxEventsPerChunk: 250,
  maskAllInputs: true,
  captureHeatmap: true,
  pointerMoveThrottleMs: 50,
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

      // ─── Scroll-reach tracking ───────────────────────────────────────────
      // The heatmap viewer's scroll-reach gradient bar needs to know "how
      // far down the page did each user actually scroll".  We track two
      // running maxes PER SCREEN:
      //
      //   maxScrollY  — furthest scrollTop the window ever reached
      //   maxBottomY  — furthest bottom-of-viewport Y (maxScrollY + viewport height)
      //
      // Every user who loaded the page automatically "reached" Y in
      // [0, viewportHeight] because that's the first fold — we initialize
      // maxBottomY to `window.innerHeight` on screen-change so the hero
      // always counts as 100% reach even for users who never scrolled.
      //
      // Both values RESET when the host calls `setCurrentScreen()` so
      // each screen gets its own reach curve, not a cumulative one
      // across multi-page sessions.  We detect the screen change
      // lazily by comparing context.getSnapshot().currentScreen to
      // the last value we observed — the client SDK doesn't expose a
      // subscription API for screen changes yet.
      let maxScrollY = 0;
      let maxBottomY = 0;
      let lastTrackedScreen: string | null = null;
      const maybeResetForScreenChange = () => {
        try {
          const screen = context.getSnapshot().currentScreen;
          if (lastTrackedScreen === null) {
            lastTrackedScreen = screen;
            return;
          }
          if (screen !== lastTrackedScreen) {
            lastTrackedScreen = screen;
            maxScrollY = 0;
            maxBottomY = 0;
          }
        } catch {
          /* getSnapshot may throw during teardown — ignore */
        }
      };
      const measureScrollReach = () => {
        if (typeof window === "undefined") return;
        maybeResetForScreenChange();
        const y = window.pageYOffset ?? window.scrollY ?? 0;
        const vh = window.innerHeight || 0;
        if (y > maxScrollY) maxScrollY = y;
        const bottom = y + vh;
        if (bottom > maxBottomY) maxBottomY = bottom;
      };

      // ─── Heatmap interaction listeners ───────────────────────────────────
      let lastPointerMoveAt = 0;
      // Spatial coalesce — same algorithm as the iOS interceptor.  Drops
      // pointer_move samples whose (x, y) is within MOVE_COALESCE_PX of the
      // previous recorded sample.  Eliminates jitter samples while a mouse
      // is held still and stops a single drag from producing 200+ rows.
      const MOVE_COALESCE_PX = 4;
      let lastMoveX = -9999;
      let lastMoveY = -9999;
      // Double-click recognizer — tracks the last pointer_down so that the
      // next pointer_down within DOUBLE_CLICK_INTERVAL_MS / DOUBLE_CLICK_RADIUS_PX
      // can be tagged with a synthetic TAP_TYPE_DOUBLE marker event.
      let lastClickAt = 0;
      let lastClickX = -9999;
      let lastClickY = -9999;
      const pointerListeners: Array<{ type: string; fn: (e: Event) => void }> = [];

      // Sampled at click/move time so the worker can normalize against the
      // page as it existed at the moment of the gesture rather than at
      // chunk-flush time.  Cheap (a few DOM property reads) but we still
      // skip it for moves — at 20 samples/sec the cost would dominate.
      const measureDocSize = (): { dw: number; dh: number } | null => {
        if (typeof document === "undefined") return null;
        const docEl = document.documentElement;
        const body = document.body;
        const dw = Math.max(
          docEl?.scrollWidth ?? 0,
          docEl?.offsetWidth ?? 0,
          body?.scrollWidth ?? 0,
          body?.offsetWidth ?? 0,
          window.innerWidth || 0,
        );
        const dh = Math.max(
          docEl?.scrollHeight ?? 0,
          docEl?.offsetHeight ?? 0,
          body?.scrollHeight ?? 0,
          body?.offsetHeight ?? 0,
          window.innerHeight || 0,
        );
        if (dw <= 0 || dh <= 0) return null;
        return { dw, dh };
      };

      const pushHeatmapEvent = (
        clientX: number,
        clientY: number,
        type: number,
        target: Element | null = null,
      ) => {
        if (
          !Number.isFinite(clientX) ||
          !Number.isFinite(clientY) ||
          clientX < 0 ||
          clientY < 0
        ) {
          return;
        }
        // A new touch sequence resets the move tracker so the first move
        // sample after a down is always recorded.
        if (type === TAP_TYPE_DOWN) {
          lastMoveX = -9999;
          lastMoveY = -9999;
        }
        // Spatial coalesce for moves only.
        if (type === TAP_TYPE_MOVE) {
          const dx = clientX - lastMoveX;
          const dy = clientY - lastMoveY;
          if (dx * dx + dy * dy < MOVE_COALESCE_PX * MOVE_COALESCE_PX) {
            return;
          }
          lastMoveX = clientX;
          lastMoveY = clientY;
        }
        const fresh = context.getSnapshot();
        // Compute the stable selector once at click time, while the live
        // DOM is available.  Move events skip selector capture (they're
        // not used for element attribution and the selector cost would
        // dominate the budget at 20 samples/sec).
        const selector =
          type === TAP_TYPE_MOVE ? undefined : stableSelectorFor(target);
        // Sample document size on click/up but skip moves — selector
        // attribution and per-event doc-size are both click-only signals.
        const docSize = type === TAP_TYPE_MOVE ? null : measureDocSize();
        const evt: HeatmapInteractionEvent = {
          type: RRWEB_INCREMENTAL_SNAPSHOT,
          data: {
            source: HEATMAP_SOURCE_TAP,
            type,
            id: 1,
            x: clientX,
            y: clientY,
            ...(selector ? { selector } : {}),
            ...(docSize ? { dw: docSize.dw, dh: docSize.dh } : {}),
          },
          timestamp: Date.now(),
          // Tag with the current screen so the worker can attribute the
          // interaction even if the chunk spans a screen change.
          screen: fresh.currentScreen,
        };
        // Bootstrap chunk metadata if this is the first event in the buffer.
        if (buffer.length === 0) {
          snapshot = fresh;
          bufferSessionId = fresh.sessionId;
          bufferDistinctId = fresh.distinctId;
          chunkStartedAt = evt.timestamp;
        }
        buffer.push(evt as unknown as eventWithTime);

        // ── Double-click recognition ─────────────────────────────────────
        // Runs ONLY on pointer_down events (so the up/move events don't
        // accidentally trigger a second match).  When the current click
        // lands inside the recognition window, we push an additional
        // synthetic event with type = TAP_TYPE_DOUBLE so the dashboard's
        // double-click filter can render a "2×" marker at this site.
        // The original pointer_down stays in the buffer so the click
        // heatmap intensity is unaffected.
        if (type === TAP_TYPE_DOWN) {
          const now = evt.timestamp;
          const dt = now - lastClickAt;
          const dxc = clientX - lastClickX;
          const dyc = clientY - lastClickY;
          const isDouble =
            lastClickAt > 0 &&
            dt < DOUBLE_CLICK_INTERVAL_MS &&
            dxc * dxc + dyc * dyc <
              DOUBLE_CLICK_RADIUS_PX * DOUBLE_CLICK_RADIUS_PX;

          if (isDouble) {
            const dblEvt: HeatmapInteractionEvent = {
              type: RRWEB_INCREMENTAL_SNAPSHOT,
              data: {
                source: HEATMAP_SOURCE_TAP,
                type: TAP_TYPE_DOUBLE,
                id: 1,
                x: clientX,
                y: clientY,
                ...(selector ? { selector } : {}),
                ...(docSize ? { dw: docSize.dw, dh: docSize.dh } : {}),
              },
              timestamp: now,
              screen: fresh.currentScreen,
            };
            buffer.push(dblEvt as unknown as eventWithTime);
            // Reset so a third click in the same cluster doesn't fire
            // another double-click marker.
            lastClickAt = 0;
            lastClickX = -9999;
            lastClickY = -9999;
          } else {
            lastClickAt = now;
            lastClickX = clientX;
            lastClickY = clientY;
          }
        }

        if (buffer.length >= config.maxEventsPerChunk) {
          void flushBufferedChunk({ reason: "buffer" });
        }
      };

      const installPointerListeners = () => {
        if (!config.captureHeatmap || pointerListeners.length > 0) return;
        if (typeof window === "undefined" || typeof document === "undefined") return;

        // 📐 We send pageX / pageY (document-relative) instead of
        // clientX / clientY (viewport-relative) so the dashboard can
        // render the FULL page heatmap — clicks at the bottom of a long
        // scrolled page now plot at their true document position rather
        // than collapsing onto the captured viewport.  The replay worker
        // normalizes against device_context.document_height (set in the
        // chunk envelope below) for the same reason.
        const onPointerDown = (e: Event) => {
          const pe = e as PointerEvent;
          pushHeatmapEvent(
            pe.pageX,
            pe.pageY,
            TAP_TYPE_DOWN,
            pe.target as Element | null,
          );
        };
        const onPointerUp = (e: Event) => {
          const pe = e as PointerEvent;
          pushHeatmapEvent(
            pe.pageX,
            pe.pageY,
            TAP_TYPE_UP,
            pe.target as Element | null,
          );
        };
        const onPointerMove = (e: Event) => {
          const now = Date.now();
          if (now - lastPointerMoveAt < config.pointerMoveThrottleMs) return;
          lastPointerMoveAt = now;
          const pe = e as PointerEvent;
          pushHeatmapEvent(pe.pageX, pe.pageY, TAP_TYPE_MOVE);
        };

        document.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
        document.addEventListener("pointerup", onPointerUp, { passive: true, capture: true });
        document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });

        // Scroll listener for scroll-reach tracking.  Runs on the window
        // (not document) so it captures top-level page scroll.  Passive so
        // we never block the scroll animation.
        const onScroll = () => measureScrollReach();
        window.addEventListener("scroll", onScroll, { passive: true });
        // Seed with the current position so "never scrolled" still counts
        // the first fold as reached.
        measureScrollReach();

        pointerListeners.push(
          { type: "pointerdown", fn: onPointerDown },
          { type: "pointerup", fn: onPointerUp },
          { type: "pointermove", fn: onPointerMove },
          { type: "scroll", fn: onScroll },
        );
      };

      const uninstallPointerListeners = () => {
        if (pointerListeners.length === 0) return;
        if (typeof document === "undefined") return;
        for (const { type, fn } of pointerListeners) {
          // The scroll listener is installed on `window`, not `document`.
          // Detach from the right event target so we don't leak.
          if (type === "scroll") {
            window.removeEventListener(type, fn);
          } else {
            document.removeEventListener(type, fn, { capture: true } as any);
          }
        }
        pointerListeners.length = 0;
      };

      const stopAndCleanup = () => {
        if (flushTimer !== null) {
          window.clearInterval(flushTimer);
          flushTimer = null;
        }
        stopRecording?.();
        stopRecording = undefined;
        uninstallPointerListeners();
      };

      const startRecording = () => {
        if (stopRecording) return;

        stopRecording = record({
          emit(event, isCheckout) {
            // 🚨 CHECKOUT BOUNDARY HANDLING
            //
            // When rrweb takes a fresh FullSnapshot (because checkoutEveryNms
            // elapsed or maxEventsPerChunk would otherwise straddle the boundary),
            // we MUST flush whatever's in the current buffer BEFORE the new
            // FullSnapshot lands in it.  Otherwise the new FullSnapshot ends up
            // in the middle of a chunk and the player sees a chunk that starts
            // with mutations referencing nodes the previous FullSnapshot defined
            // — but those nodes have all been re-minted with NEW IDs by the
            // checkout, so every mutation fails with "Node with id 'N' not found".
            //
            // After the flush, the new chunk starts with the freshly emitted
            // Meta + FullSnapshot pair, and every subsequent chunk produced by
            // the same checkout window is self-contained.
            if (isCheckout && buffer.length > 0) {
              void flushBufferedChunk({ reason: "buffer" });
            }

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
          // 🚨 CRITICAL: take a fresh FullSnapshot every 30 seconds.  Without
          // this, rrweb only emits a FullSnapshot ONCE at the start of
          // recording.  Long sessions and React-heavy first-paints fill the
          // 250-event buffer in <1 second, so chunks 1+ contain only mutations
          // that reference nodes minted in chunk 0's FullSnapshot — and as
          // soon as a node is created within chunk 1 and modified later in
          // chunk 1, the player can't render it because the create-mutation
          // is in a *different* chunk.
          //
          // Setting checkoutEveryNms makes rrweb periodically reset its mirror
          // and emit a fresh Meta + FullSnapshot, ensuring every chunk that
          // crosses a checkout boundary contains its own self-contained DOM
          // baseline.  30s is the standard rrweb default for this pattern.
          checkoutEveryNms: 30_000,
        });

        if (flushTimer === null) {
          flushTimer = window.setInterval(() => {
            void flushBufferedChunk({
              reason: "timer",
            });
          }, config.flushIntervalMs);
        }

        installPointerListeners();
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

        // The Sankofa replay worker (server/engine/ee/replay/worker.go) reads
        // device_context.{screen_width,screen_height} to normalize interaction
        // coordinates to 0–1 before inserting into ClickHouse.  Without this
        // field, screenW/screenH fall back to iPhone defaults (393×852) and
        // every web heatmap dot lands in the wrong spot.
        //
        // For full-page web heatmaps we ALSO send document_width /
        // document_height — the natural size of the entire scrollable page
        // at chunk-flush time.  Combined with pageX/pageY in the click
        // events (see installPointerListeners above), this lets the worker
        // store document-relative normalized coordinates so the dashboard
        // can render the full long page with heat anchored to the right
        // spots — not just the captured viewport region.
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const docEl = document.documentElement;
        const documentWidth = Math.max(
          docEl?.scrollWidth ?? 0,
          docEl?.offsetWidth ?? 0,
          document.body?.scrollWidth ?? 0,
          document.body?.offsetWidth ?? 0,
          viewportWidth,
        );
        const documentHeight = Math.max(
          docEl?.scrollHeight ?? 0,
          docEl?.offsetHeight ?? 0,
          document.body?.scrollHeight ?? 0,
          document.body?.offsetHeight ?? 0,
          viewportHeight,
        );

        const body = {
          mode: "rrweb" as const,
          // Both the legacy (`session_id`/`distinct_id`/`chunk_index`) and the
          // newer (`_session_id`/`_distinct_id`/`_chunk_index`) field shapes
          // are populated so the worker can read either.
          session_id: sessionId,
          distinct_id: distinctId,
          chunk_index: currentChunkIndex,
          _session_id: sessionId,
          _distinct_id: distinctId,
          _chunk_index: currentChunkIndex,
          _replay_mode: "rrweb",
          started_at: new Date(startedAt).toISOString(),
          ended_at: new Date(endedAt).toISOString(),
          event_count: events.length,
          events,
          $app_version: SANKOFA_BROWSER_VERSION,
          device_context: {
            screen_width: viewportWidth,
            screen_height: viewportHeight,
            // Full-page dimensions — used by the worker to normalize
            // page-relative pointer events to [0, 1] document coordinates.
            document_width: documentWidth,
            document_height: documentHeight,
            $os: "web",
            $app_version: SANKOFA_BROWSER_VERSION,
          },
          meta: {
            url: window.location.href,
            current_screen: snapshot.currentScreen,
            viewport: {
              width: viewportWidth,
              height: viewportHeight,
            },
            document: {
              width: documentWidth,
              height: documentHeight,
            },
            // Scroll-reach summary for this chunk.  Powers the heatmap
            // viewer's scroll-reach gradient bar.  Server worker reads
            // this and INSERTs a row into scroll_reach_sessions keyed by
            // (project, env, session_id, screen_name), and the dashboard
            // aggregates across sessions at query time.
            //
            // max_scroll_y  — furthest scrollTop the window ever hit
            // max_bottom_y  — max(scrollY + innerHeight) — the FURTHEST
            //                 Y that was ever visible in the user's
            //                 viewport (so the first fold counts even
            //                 when scrollY is always 0)
            scroll_reach: {
              max_scroll_y: maxScrollY,
              max_bottom_y: maxBottomY,
              viewport_height: viewportHeight,
              document_height: documentHeight,
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
