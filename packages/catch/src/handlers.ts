import type { SankofaCatchClient } from './client';

/**
 * Global error handlers install once per page load. They forward
 * uncaught exceptions, unhandled promise rejections, and console.error
 * calls into the SankofaCatchClient without interfering with any
 * existing handlers (chained politely, not replaced).
 *
 * Each hook can be opted out via the plugin's `captureUnhandled` /
 * `captureRejections` / `captureConsoleError` options.
 */

export interface InstallOptions {
  client: SankofaCatchClient;
  captureUnhandled?: boolean;
  captureRejections?: boolean;
  captureConsoleError?: boolean;
  debug?: (msg: string, ...rest: unknown[]) => void;
}

export interface InstalledHandlers {
  uninstall(): void;
}

const DEFAULT_CAPTURE_UNHANDLED = true;
const DEFAULT_CAPTURE_REJECTIONS = true;
// console.error-driven capture is OFF by default — most apps log
// handled errors to console for dev visibility and don't want each
// one billed as a Catch event. Opt in per project.
const DEFAULT_CAPTURE_CONSOLE_ERROR = false;

export function installGlobalHandlers(options: InstallOptions): InstalledHandlers {
  const {
    client,
    captureUnhandled = DEFAULT_CAPTURE_UNHANDLED,
    captureRejections = DEFAULT_CAPTURE_REJECTIONS,
    captureConsoleError = DEFAULT_CAPTURE_CONSOLE_ERROR,
    debug = () => {},
  } = options;

  const uninstallers: Array<() => void> = [];

  if (typeof window !== 'undefined') {
    // ── window.onerror ───────────────────────────────────────────
    if (captureUnhandled) {
      const handler = (event: ErrorEvent) => {
        try {
          const err = event.error ?? event.message ?? 'unknown error';
          client.captureRaw(err, {
            type: 'unhandled_exception',
            mechanismType: 'global_handler',
            handled: false,
            options: {
              extra: {
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
              },
            },
          });
        } catch (err) {
          debug('catch: onerror handler threw', err);
        }
        // Don't preventDefault — let the app's own handlers still fire.
      };
      window.addEventListener('error', handler, { capture: true });
      uninstallers.push(() => window.removeEventListener('error', handler, true));
    }

    // ── unhandledrejection ──────────────────────────────────────
    if (captureRejections) {
      const handler = (event: PromiseRejectionEvent) => {
        try {
          const reason = event.reason;
          client.captureRaw(reason, {
            type: 'unhandled_rejection',
            mechanismType: 'unhandled_rejection',
            handled: false,
          });
        } catch (err) {
          debug('catch: unhandledrejection handler threw', err);
        }
      };
      window.addEventListener('unhandledrejection', handler, { capture: true });
      uninstallers.push(() => window.removeEventListener('unhandledrejection', handler, true));
    }
  }

  // ── console.error patch (opt-in) ────────────────────────────────
  if (captureConsoleError && typeof console !== 'undefined') {
    const original = console.error;
    console.error = function (...args: unknown[]) {
      try {
        const message = args.map(arg =>
          arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg),
        ).join(' ');
        client.captureMessage(message.slice(0, 1024));
      } catch (err) {
        debug('catch: console.error patch threw', err);
      }
      original.apply(console, args);
    };
    uninstallers.push(() => {
      console.error = original;
    });
  }

  return {
    uninstall: () => {
      for (const u of uninstallers) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
