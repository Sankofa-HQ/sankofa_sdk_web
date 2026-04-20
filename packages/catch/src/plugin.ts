import type { SankofaPlugin, SankofaPluginContext } from '@sankofa/browser';

import { BreadcrumbsAutocapture, BreadcrumbsBuffer } from './breadcrumbs';
import { SankofaCatchClient } from './client';
import { installGlobalHandlers, type InstalledHandlers } from './handlers';
import { Transport } from './transport';
import type { CatchHandshakeConfig, SankofaCatchAPI } from './types';

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
        // Cross-product snapshots — host-app-supplied. When the host
        // wires them up, every error carries the flag + config state
        // at capture time so dashboards can show "what was on when
        // this broke".
        readFlagSnapshot: options.readFlagSnapshot,
        readConfigSnapshot: options.readConfigSnapshot,
      });

      singleton = client;

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

      return {
        applyHandshake(cfg: unknown) {
          client.applyHandshake(cfg as CatchHandshakeConfig | undefined);
        },
        async flush() {
          await client.flush();
        },
        async shutdown() {
          installed?.uninstall();
          autocapture.uninstall();
          transport.shutdown();
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

