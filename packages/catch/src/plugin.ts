import type { SankofaPlugin, SankofaPluginContext } from '@sankofa/browser';
import { getModuleAPI, registerModuleAPI, unregisterModuleAPI } from '@sankofa/browser';

import { BreadcrumbsAutocapture, BreadcrumbsBuffer } from './breadcrumbs';
import { SankofaCatchClient } from './client';
import { installGlobalHandlers, type InstalledHandlers } from './handlers';
import { Transport } from './transport';
import { PerfTransport } from './perf-transport';
import { WebVitals, emitNavigationTransaction, type PerfSink } from './perf';
import type { BeforeSendFn, CatchHandshakeConfig, SankofaCatchAPI } from './types';

// Duck-typed shape of what @sankofa/switch + @sankofa/config publish
// via `registerModuleAPI`. Defined inline so this file doesn't have to
// take a build-time dependency on either package — the registry's
// contract is the only thing that matters at the call site.
interface FlagAPILike {
  getAllKeys(): string[];
  getDecision(key: string): { value: boolean; variant?: string } | null;
}
interface ConfigAPILike {
  getAll(): Record<string, unknown>;
}

/**
 * Module-scoped singleton returned from getCatch(). Matches the
 * pattern used by @sankofa/switch and @sankofa/config so host apps
 * can read the Catch API from anywhere without threading the client
 * through every call site.
 */
let singleton: SankofaCatchClient | null = null;

export interface CatchPluginOptions {
  /**
   * Attach uncaught `window.onerror` events to Catch. Default true.
   */
  captureUnhandled?: boolean;
  /**
   * Attach `unhandledrejection` events to Catch. Default true.
   */
  captureRejections?: boolean;
  /**
   * Capture every `console.error(...)` call as a Catch event.
   * Default false — most apps log handled errors to console for dev
   * visibility and don't want them billed as Catch events.
   */
  captureConsoleError?: boolean;
  /**
   * Autocapture breadcrumb hooks (console, fetch, XHR, clicks,
   * navigation). Default true. Set to false in environments where
   * monkey-patching fetch/XHR is unsafe.
   */
  autocapture?: boolean;
  /**
   * Override the release identifier attached to every event.
   * Defaults to the SDK's own version; host apps with their own
   * release strings should pass it explicitly.
   */
  release?: string;
  /**
   * Override the app version attached to device context.
   */
  appVersion?: string;
  /**
   * If provided, called on uncaught errors to request a high-
   * fidelity session-replay burst. Only fires when the Replay
   * plugin exposes `notifyHighFidelity` on the plugin context.
   */
  triggerReplayOnError?: boolean;
  /**
   * Environment the project is running in. Defaults to "live";
   * set "test" to route events to the test dataset.
   */
  environment?: 'live' | 'test';

  /**
   * Optional — called at event-capture time to read the current
   * feature-flag decisions. The return map becomes the event's
   * `flag_snapshot` so dashboards can show "which flags were ON when
   * this error fired".
   *
   * Wire it up with @sankofa/switch's `getSwitch()`:
   *
   *   catchPlugin({
   *     readFlagSnapshot: () => {
   *       const s = getSwitch();
   *       if (!s) return undefined;
   *       const out: Record<string, string> = {};
   *       for (const k of s.getAllKeys()) {
   *         const d = s.getDecision(k);
   *         if (d) out[k] = d.variant ?? String(d.value);
   *       }
   *       return out;
   *     },
   *   })
   */
  readFlagSnapshot?: () => Record<string, string> | undefined;

  /**
   * Optional — called at event-capture time to read the current
   * remote config values. Pair with @sankofa/config's `getConfig()`:
   *
   *   catchPlugin({
   *     readConfigSnapshot: () => getConfig()?.getAll(),
   *   })
   */
  readConfigSnapshot?: () => Record<string, unknown> | undefined;

  /**
   * Emit Web Vitals (LCP, CLS, FCP, INP, TTFB) via PerformanceObserver
   * and a single `pageload` transaction summarising the navigation
   * timeline. Default true. Set to false in diagnostic-only builds.
   */
  capturePerformance?: boolean;

  /**
   * Synchronous hook called AFTER an event has been composed but
   * BEFORE the transport sends it. Return the (possibly modified)
   * event to ship it; return `null` to drop it entirely.
   *
   * Common use cases:
   *   - PII scrubbing — strip emails / tokens from event payloads.
   *   - Noise filtering — drop known-benign errors (ResizeObserver
   *     loop limit, etc.) without paying for them in your Catch quota.
   *   - Late tag enrichment — attach app state that wasn't available
   *     at plugin init time.
   *
   * Throwing inside `beforeSend` is treated like returning the event
   * unchanged — a host bug must never break the capture pipeline.
   */
  beforeSend?: BeforeSendFn;
}

/**
 * The factory every app passes to `Sankofa.init({ plugins: [...] })`.
 * Self-contained — reads its ingest URL + API key from the browser
 * client snapshot, so host apps don't need to plumb anything manually.
 */
export function catchPlugin(options: CatchPluginOptions = {}): SankofaPlugin {
  return {
    name: 'catch',
    moduleName: 'catch',
    setup(context: SankofaPluginContext) {
      const snap = context.getSnapshot();
      const debug = (msg: string, ...rest: unknown[]) => context.debug(`[catch] ${msg}`, ...rest);

      if (!snap.catchIngestUrl || !snap.apiKey) {
        debug('catchIngestUrl or apiKey missing from snapshot — plugin will not run');
        return;
      }

      const buffer = new BreadcrumbsBuffer(100);
      const autocapture = new BreadcrumbsAutocapture({
        buffer,
        debug,
        console: true,
        fetch: true,
        xhr: true,
        clicks: true,
        navigation: true,
      });

      const transport = new Transport({
        endpoint: snap.catchIngestUrl,
        apiKey: snap.apiKey,
        storagePrefix: snap.projectNamespace,
        debug,
      });

      const client = new SankofaCatchClient({
        transport,
        buffer,
        autocapture,
        snapshot: () => {
          const s = context.getSnapshot();
          return {
            distinctId: s.distinctId,
            anonymousId: s.anonymousId,
            sessionId: s.sessionId,
            libVersion: s.libVersion,
            currentScreen: s.currentScreen,
          };
        },
        environment: options.environment ?? 'live',
        release: options.release,
        appVersion: options.appVersion,
        debug,
        triggerReplay: options.triggerReplayOnError !== false
          ? () => {
              try {
                context.triggerHighFidelity?.();
              } catch (err) {
                debug('triggerHighFidelity threw', err);
              }
            }
          : undefined,
        // Cross-product snapshots. When the host passes explicit
        // `readFlagSnapshot` / `readConfigSnapshot` we honor those (no
        // surprises for code already wired up). Otherwise we look the
        // Switch + Config singletons up from the cross-module registry
        // — set there by `switchPlugin()` / `configPlugin()` setup —
        // so every error carries the flag + config state at capture
        // time without any host glue.
        readFlagSnapshot: options.readFlagSnapshot ?? autoFlagSnapshot,
        readConfigSnapshot: options.readConfigSnapshot ?? autoConfigSnapshot,
        beforeSend: options.beforeSend,
      });

      singleton = client;
      // Expose the client via the registry so `Sankofa.captureException`
      // and friends (defined in @sankofa/browser) can find it without
      // a hard import of @sankofa/catch.
      registerModuleAPI('catch', client);

      if (options.autocapture !== false) {
        autocapture.install();
      }

      let installed: InstalledHandlers | null = null;
      installed = installGlobalHandlers({
        client,
        captureUnhandled: options.captureUnhandled,
        captureRejections: options.captureRejections,
        captureConsoleError: options.captureConsoleError,
        debug,
      });

      // ── Performance (M7) ─────────────────────────────────────────
      // Web Vitals + pageload transaction. Kept in the plugin wire-up
      // so host apps get it for free once catchPlugin is registered;
      // opt out via options.capturePerformance=false.
      let perfTransport: PerfTransport | null = null;
      let webVitals: WebVitals | null = null;
      if (options.capturePerformance !== false) {
        perfTransport = new PerfTransport({
          endpoint: snap.catchIngestUrl,
          apiKey: snap.apiKey,
          debug,
        });
        const perfSink: PerfSink = {
          postVitals: (items) => perfTransport?.postVitals(items),
          postTransactions: (items) => perfTransport?.postTransactions(items),
          snapshot: () => {
            const s = context.getSnapshot();
            return {
              distinctId: s.distinctId,
              anonymousId: s.anonymousId,
              sessionId: s.sessionId,
              release: options.release,
              environment: options.environment ?? 'live',
            };
          },
        };
        webVitals = new WebVitals(perfSink);
        try {
          webVitals.start();
        } catch (err) {
          debug('webVitals start failed', err);
        }
        // Emit the pageload transaction after load so the navigation
        // timing entry is populated. Fires once; subsequent SPA
        // navigations are outside V1 scope.
        const emitPageload = () => {
          try { emitNavigationTransaction(perfSink); } catch (err) { debug('pageload failed', err); }
        };
        if (typeof document !== 'undefined' && document.readyState === 'complete') {
          // Give the browser a beat so loadEventEnd is non-zero.
          setTimeout(emitPageload, 0);
        } else if (typeof window !== 'undefined') {
          window.addEventListener('load', () => setTimeout(emitPageload, 0), { once: true });
        }
      }

      return {
        applyHandshake(cfg: unknown) {
          client.applyHandshake(cfg as CatchHandshakeConfig | undefined);
        },
        async flush() {
          await client.flush();
          await perfTransport?.flush();
        },
        async shutdown() {
          installed?.uninstall();
          autocapture.uninstall();
          transport.shutdown();
          webVitals?.stop();
          perfTransport?.shutdown();
          unregisterModuleAPI('catch');
          singleton = null;
        },
      };
    },
  };
}

/**
 * Host-side accessor. Returns the active SankofaCatchAPI when the
 * plugin has been registered and Sankofa.init has resolved; null
 * otherwise (so host code can handle the "forgot to include
 * catchPlugin" case gracefully).
 */
export function getCatch(): SankofaCatchAPI | null {
  return singleton;
}

// ── Auto-discovery (Switch + Config snapshots) ──────────────────────
//
// Default closures handed to the catch client when the host didn't pass
// explicit `readFlagSnapshot` / `readConfigSnapshot`. They look the
// sibling modules up from the cross-module registry — populated by
// `switchPlugin()` / `configPlugin()` setup — so a forgotten options
// wire-up doesn't silently drop flag + config context from every event.

function autoFlagSnapshot(): Record<string, string> | undefined {
  const switchApi = getModuleAPI<FlagAPILike>('switch');
  if (!switchApi) return undefined;
  const out: Record<string, string> = {};
  for (const k of switchApi.getAllKeys()) {
    const d = switchApi.getDecision(k);
    if (!d) continue;
    // Variants render as the variant key; pure boolean flags render
    // as "true"/"false" so the dashboard can group on the value
    // without re-resolving.
    out[k] = d.variant && d.variant.length > 0 ? d.variant : String(d.value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function autoConfigSnapshot(): Record<string, unknown> | undefined {
  const configApi = getModuleAPI<ConfigAPILike>('config');
  if (!configApi) return undefined;
  const all = configApi.getAll();
  return Object.keys(all).length > 0 ? all : undefined;
}

