// Performance module for the browser Catch SDK.
//
// Scope:
//   - Capture Core Web Vitals (LCP, CLS, FCP, TTFB, INP) via the
//     PerformanceObserver API. No dependency on the `web-vitals`
//     package — the observer API is stable enough to read directly,
//     and a hand-rolled implementation keeps the SDK under its byte
//     budget.
//   - Emit a single navigation transaction per page lifetime with the
//     relevant timings as child spans + the final vitals as tags.
//
// Key trade-offs:
//   - We don't re-implement the `web-vitals` polyfill logic. Browsers
//     that don't support LayoutShift, LargestContentfulPaint, or
//     PerformanceEventTiming simply skip those metrics. The server's
//     Web Vitals dashboard already handles sparse coverage.
//   - Network writes use `navigator.sendBeacon` on page-unload so
//     vitals don't get dropped by the tab-close race. Falls back to
//     fetch+keepalive.

import { WireVersionCurrent } from './types';
import type {
  Platform,
  SDKInfo,
  VitalMetric,
  VitalRating,
  TransactionWire,
  SpanWire,
  WebVitalWire,
} from './types';

const SDK_INFO: SDKInfo = { name: 'sankofa.web', version: '0.1.0' };

// Web Vitals thresholds — lifted from web.dev's Core Web Vitals
// scoring rubric. "good" ≤ first, "poor" > second.
const THRESHOLDS: Record<VitalMetric, [number, number]> = {
  lcp: [2500, 4000],
  fid: [100, 300],
  cls: [0.1, 0.25],
  inp: [200, 500],
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  fp: [1800, 3000],
};

function rate(metric: VitalMetric, value: number): VitalRating {
  const t = THRESHOLDS[metric];
  if (!t) return 'needs-improvement';
  if (value <= t[0]) return 'good';
  if (value <= t[1]) return 'needs-improvement';
  return 'poor';
}

export interface PerfSinkSnapshot {
  distinctId?: string;
  anonymousId?: string;
  sessionId?: string;
  release?: string;
  environment: 'live' | 'test';
}

export interface PerfSink {
  postVitals(batch: WebVitalWire[]): void;
  postTransactions(batch: TransactionWire[]): void;
  snapshot(): PerfSinkSnapshot;
}

/**
 * WebVitals — one instance per page lifetime. Observes LCP, CLS,
 * FCP, TTFB, INP and forwards each to the sink. Stops observing on
 * `stop()` (e.g. plugin shutdown).
 */
export class WebVitals {
  private readonly sink: PerfSink;
  private observers: PerformanceObserver[] = [];
  private clsValue = 0;
  private clsEntries: PerformanceEntry[] = [];
  private reported: Partial<Record<VitalMetric, true>> = {};
  private platform: Platform = 'javascript';

  constructor(sink: PerfSink) {
    this.sink = sink;
  }

  start(): void {
    if (typeof PerformanceObserver !== 'function') return;
    this.observeLCP();
    this.observeCLS();
    this.observeFCP();
    this.observeTTFB();
    this.observeINP();
    // Flush on page hide — vitals are only valid at end-of-session for
    // CLS, and we want the final LCP landed before the tab closes.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  stop(): void {
    for (const obs of this.observers) {
      try { obs.disconnect(); } catch { /* noop */ }
    }
    this.observers = [];
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('pagehide', this.onPageHide);
    }
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.finalize();
  };

  private onPageHide = () => {
    this.finalize();
  };

  private finalize(): void {
    // Emit the sticky (one-shot) metrics even if their final-value
    // observers haven't fired yet.
    this.reportCLS();
  }

  // ── Observers ───────────────────────────────────────────────────

  private observeLCP(): void {
    this.safeObserve('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
      if (!last || this.reported.lcp) return;
      this.reported.lcp = true;
      this.emit('lcp', last.startTime);
    });
  }

  private observeCLS(): void {
    this.safeObserve('layout-shift', (entries) => {
      for (const e of entries) {
        // hadRecentInput filters out shifts caused by user input —
        // those don't count toward CLS.
        const ls = e as unknown as { value: number; hadRecentInput: boolean };
        if (ls.hadRecentInput) continue;
        this.clsValue += ls.value;
        this.clsEntries.push(e);
      }
    });
  }

  private reportCLS(): void {
    if (this.reported.cls) return;
    this.reported.cls = true;
    this.emit('cls', this.clsValue);
  }

  private observeFCP(): void {
    this.safeObserve('paint', (entries) => {
      for (const e of entries) {
        if (e.name === 'first-contentful-paint' && !this.reported.fcp) {
          this.reported.fcp = true;
          this.emit('fcp', e.startTime);
        }
      }
    });
  }

  private observeTTFB(): void {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return;
    const ttfb = Math.max(0, nav.responseStart - nav.startTime);
    this.reported.ttfb = true;
    this.emit('ttfb', ttfb);
  }

  private observeINP(): void {
    let worstDuration = 0;
    this.safeObserve('event', (entries) => {
      for (const e of entries) {
        const d = (e as unknown as { duration: number }).duration;
        if (d > worstDuration) {
          worstDuration = d;
        }
      }
      if (worstDuration > 0 && !this.reported.inp) {
        this.reported.inp = true;
        this.emit('inp', worstDuration);
      }
    });
  }

  private safeObserve(type: string, cb: (entries: PerformanceEntry[]) => void): void {
    try {
      const obs = new PerformanceObserver((list) => cb(list.getEntries()));
      // buffered: true replays entries that fired before we attached —
      // matters for FCP/TTFB when the SDK inits after paint.
      obs.observe({ type, buffered: true } as PerformanceObserverInit);
      this.observers.push(obs);
    } catch {
      // Browser doesn't support this entry type — skip silently.
    }
  }

  private emit(metric: VitalMetric, value: number): void {
    const snap = this.sink.snapshot();
    const wire: WebVitalWire = {
      wire_version: WireVersionCurrent,
      event_id: cryptoRandom(),
      environment: snap.environment,
      distinct_id: snap.distinctId,
      anon_id: snap.anonymousId,
      session_id: snap.sessionId,
      release: snap.release,
      platform: this.platform,
      sdk: SDK_INFO,
      metric,
      value,
      rating: rate(metric, value),
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      navigation: navigationType(),
      ts_ms: Date.now(),
    };
    this.sink.postVitals([wire]);
  }
}

/**
 * Emit a single navigation transaction summarising the page load —
 * runs once after the SDK init so the perf.timing table is populated.
 * Spans approximate the classic timing model: DNS, connect, request,
 * response, DOM processing, load.
 */
export function emitNavigationTransaction(sink: PerfSink): void {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!nav) return;

  const snap = sink.snapshot();
  const traceId = hexRandom(32);
  const rootSpanId = hexRandom(16);
  const startMs = Date.now() - Math.round(performance.now() - nav.startTime);

  const spans: SpanWire[] = [];
  const addSpan = (op: string, description: string, from: number, to: number) => {
    if (to <= from) return;
    spans.push({
      span_id: hexRandom(16),
      parent_span_id: rootSpanId,
      op,
      description,
      start_ms: startMs + from,
      end_ms: startMs + to,
      status: 'ok',
    });
  };
  // All fields are offsets from nav.startTime (ms). responseEnd −
  // startTime is the total observable duration on the browser side.
  addSpan('browser.dns', 'DNS', nav.domainLookupStart, nav.domainLookupEnd);
  addSpan('browser.connect', 'TCP', nav.connectStart, nav.connectEnd);
  addSpan('browser.request', 'HTTP request', nav.requestStart, nav.responseStart);
  addSpan('browser.response', 'HTTP response', nav.responseStart, nav.responseEnd);
  addSpan('browser.dom', 'DOM processing', nav.responseEnd, nav.domContentLoadedEventEnd);
  addSpan('browser.load', 'load event', nav.domContentLoadedEventEnd, nav.loadEventEnd);

  const wire: TransactionWire = {
    wire_version: WireVersionCurrent,
    event_id: cryptoRandom(),
    environment: snap.environment,
    distinct_id: snap.distinctId,
    anon_id: snap.anonymousId,
    session_id: snap.sessionId,
    release: snap.release,
    platform: 'javascript',
    sdk: SDK_INFO,
    trace_id: traceId,
    span_id: rootSpanId,
    name: (typeof window !== 'undefined' ? window.location.pathname : '/') || '/',
    op: 'pageload',
    start_ms: startMs,
    end_ms: startMs + Math.max(0, nav.loadEventEnd || nav.responseEnd),
    status: 'ok',
    sample_rate: 1,
    spans,
  };
  sink.postTransactions([wire]);
}

// ── Helpers ─────────────────────────────────────────────────────────

function cryptoRandom(): string {
  try {
    return (globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }).crypto?.randomUUID?.().replace(/-/g, '') ?? hexRandom(32);
  } catch {
    return hexRandom(32);
  }
}

function hexRandom(length: number): string {
  const bytes = new Uint8Array(length / 2);
  try {
    (globalThis as unknown as {
      crypto: { getRandomValues: (b: Uint8Array) => void };
    }).crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function navigationType(): WebVitalWire['navigation'] {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | (PerformanceNavigationTiming & { type?: string })
      | undefined;
    const t = nav?.type;
    if (t === 'navigate' || t === 'reload' || t === 'back_forward' || t === 'prerender') {
      return t === 'back_forward' ? 'back-forward' : t;
    }
  } catch { /* ignore */ }
  return undefined;
}
