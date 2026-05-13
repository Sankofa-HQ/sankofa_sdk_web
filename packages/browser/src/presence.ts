// Live-presence heartbeat — every ~15s while the document is visible
// the SDK pings `/api/v1/screens/heartbeat` so the dashboard's "X live
// now" badge reflects who's actually on each screen.
//
// Design choices:
//   - Visibility-API gated. A backgrounded tab pauses the timer
//     immediately so we don't paint stale "still live" badges for
//     users who tabbed away or minimised the browser.
//   - Idempotent on the server (touches a TTL'd cache); a missed
//     heartbeat just trims the user from the live set after the TTL
//     window — no retry / queueing needed.
//   - Best-effort fetch: failures are silent. Presence is a UX
//     decoration, not a correctness signal.
//   - Reuses Beacon API on `pagehide` so a page-close still gets one
//     final heartbeat in (server-side TTL handles the rest).

interface HeartbeatProps {
  /** Origin to derive the heartbeat URL from (same origin Catch ingest uses). */
  batchUrl: URL;
  /** Project API key — auths the heartbeat. */
  apiKey: string;
  /** Returns the SDK's view of what to send. Called per heartbeat so
   *  identity / screen changes are reflected immediately. */
  getSnapshot: () => {
    distinctId?: string;
    sessionId?: string;
    currentScreen?: string;
  };
  /** ms between heartbeats. Default 15 000. */
  intervalMs?: number;
  debug?: (msg: string, ...rest: unknown[]) => void;
}

export class SankofaPresenceHeartbeat {
  private intervalMs: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private heartbeatUrl: string;
  private apiKey: string;
  private getSnapshot: HeartbeatProps['getSnapshot'];
  private debug: (msg: string, ...rest: unknown[]) => void;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;

  constructor(props: HeartbeatProps) {
    this.intervalMs = props.intervalMs ?? 15_000;
    this.heartbeatUrl = `${props.batchUrl.origin}/api/v1/screens/heartbeat`;
    this.apiKey = props.apiKey;
    this.getSnapshot = props.getSnapshot;
    this.debug = props.debug ?? (() => {});
  }

  start(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // Prime once so the dashboard sees the user the moment they land,
    // not 15s later. Safe to call before timer kicks in because the
    // server endpoint is idempotent.
    void this.beat('boot');

    if (!document.hidden) this.scheduleTimer();

    this.visibilityHandler = () => {
      if (document.hidden) {
        this.clearTimer();
      } else {
        // Send one immediate heartbeat on resume so "live now"
        // reflects the user the instant they refocus the tab,
        // instead of waiting up to 15s for the next tick.
        void this.beat('visible');
        this.scheduleTimer();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    // Final heartbeat on page-close — uses sendBeacon so the request
    // survives the navigation. Without this, a quick close would
    // leave the user "live" for the full TTL window.
    this.pageHideHandler = () => this.beat('pagehide');
    window.addEventListener('pagehide', this.pageHideHandler);
  }

  stop(): void {
    this.clearTimer();
    if (typeof document !== 'undefined' && this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (typeof window !== 'undefined' && this.pageHideHandler) {
      window.removeEventListener('pagehide', this.pageHideHandler);
    }
    this.visibilityHandler = null;
    this.pageHideHandler = null;
  }

  private scheduleTimer(): void {
    this.clearTimer();
    this.timerId = setInterval(() => {
      void this.beat('tick');
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private async beat(reason: 'boot' | 'tick' | 'visible' | 'pagehide'): Promise<void> {
    const snap = this.getSnapshot();
    const screen =
      snap.currentScreen && snap.currentScreen !== 'Unknown'
        ? snap.currentScreen
        : typeof window !== 'undefined' && window.location?.pathname
        ? window.location.pathname
        : '';
    if (!screen || !snap.distinctId) return;

    const body = JSON.stringify({
      screen,
      distinct_id: snap.distinctId,
      session_id: snap.sessionId,
    });

    // Page-close path uses sendBeacon — fetch() during pagehide is
    // racy across browsers and frequently dropped.
    if (reason === 'pagehide' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(this.heartbeatUrl, blob);
      } catch {
        /* swallow — best effort */
      }
      return;
    }

    try {
      await fetch(this.heartbeatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body,
        // No credentials — heartbeat doesn't need cookies, and
        // omitting them avoids triggering CORS preflight on
        // cross-origin endpoints.
        credentials: 'omit',
        keepalive: reason === 'pagehide',
      });
    } catch (err) {
      this.debug('presence heartbeat failed', err);
    }
  }
}
