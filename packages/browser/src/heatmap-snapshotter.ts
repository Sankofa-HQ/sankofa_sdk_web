/**
 * Dedicated heatmap-background capture for the Web SDK.
 *
 * ## Why this exists
 * Web replay uses rrweb (DOM mutations, no raster screenshot), so the
 * dashboard's heatmap renderer historically had nothing to overlay
 * heat on — just a blank rectangle sized to the viewport. With many
 * platforms now showing the heat over half-loaded screens, the user
 * couldn't tell which UI region a hot spot referred to.
 *
 * This module captures a single, real, raster snapshot of the
 * viewport AFTER the page reaches a stable state, and uploads it to
 * `/api/heatmaps/snapshot` (capture_source = 'dedicated' on the
 * server, which out-ranks any opportunistic rrweb dimension-only
 * placeholder).
 *
 * ## Capture technique
 * Browsers can rasterize a DOM subtree without any external library
 * by serializing it into an `<svg><foreignObject>` document, drawing
 * that SVG into a `<canvas>`, and reading the canvas back as a PNG.
 * This is well-supported on modern browsers (Chrome, Firefox, Safari,
 * Edge) and has the major advantage of running entirely inside the
 * browser's compositor — no main-thread CSS layout work beyond what
 * the DOM serialization itself requires.
 *
 * ## Performance contract
 * - Scheduled via `requestIdleCallback` (with `setTimeout` fallback)
 *   after a 1.5s settle delay from the last `screen()` / pageview.
 * - DOM serialization runs inside `requestIdleCallback` so it yields
 *   to user input and animations.
 * - Image decode + draw happens in the browser's normal raster path;
 *   we never block the main thread on a long synchronous loop.
 * - One capture per `(screen, viewport-bucket)` per session — repeated
 *   `screen()` calls on the same page are no-ops.
 * - On any failure (tainted canvas, oversized DOM, security error)
 *   we fail silently — the dashboard's dimension-only fallback path
 *   keeps working unchanged.
 */

interface SnapshotterOptions {
  endpoint: string;
  apiKey: string;
  appVersion: string;
  /** Logger called only when debug mode is on; we silence all paths
   *  in production so the SDK has zero runtime visibility. */
  debug: (...args: unknown[]) => void;
}

export class HeatmapSnapshotter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly appVersion: string;
  private readonly debug: (...args: unknown[]) => void;
  private readonly captured = new Set<string>();
  private pendingToken = 0;
  /** 1.5s settle delay matches the iOS / Android counterparts so the
   *  product feels consistent across platforms. Long enough for most
   *  async image / font loads, short enough that the user is unlikely
   *  to have navigated away. */
  private readonly stabilityDelayMs = 1500;

  constructor(options: SnapshotterOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.appVersion = options.appVersion;
    this.debug = options.debug;
  }

  /**
   * Called from `Sankofa.screen(...)` and the auto-pageview hook.
   * Returns immediately. All actual work is deferred to a future
   * idle callback.
   */
  scheduleCapture(screen: string): void {
    if (!screen || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const token = ++this.pendingToken;
    window.setTimeout(() => {
      if (this.pendingToken !== token) return; // superseded
      this.runWhenIdle(screen);
    }, this.stabilityDelayMs);
  }

  private runWhenIdle(screen: string): void {
    const work = () => {
      void this.tryCapture(screen).catch((err) => {
        this.debug("Heatmap snapshot failed:", err);
      });
    };
    // requestIdleCallback is the right hammer: it only runs when the
    // browser has spare time, never blocking input handlers or
    // animation frames. Safari only got it in 16.4; fall back to a
    // generous setTimeout there.
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof idle === "function") {
      idle(work, { timeout: 3000 });
    } else {
      setTimeout(work, 0);
    }
  }

  private async tryCapture(screen: string): Promise<void> {
    const docEl = document.documentElement;
    const body = document.body;
    if (!docEl || !body) return;

    const viewportWidth = Math.max(docEl.clientWidth || 0, window.innerWidth || 0);
    const viewportHeight = Math.max(docEl.clientHeight || 0, window.innerHeight || 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return;

    const fingerprint = `${screen}|${this.appVersion}|${bucket(viewportWidth)}x${bucket(viewportHeight)}`;
    if (this.captured.has(fingerprint)) return;
    this.captured.add(fingerprint);

    // Capture is best-effort. We mark the fingerprint as captured
    // BEFORE the await so a re-fire while in flight is a no-op (rather
    // than racing two simultaneous serializations of a large DOM).
    let dataUrl: string;
    try {
      dataUrl = await renderViewportToPng(viewportWidth, viewportHeight);
    } catch (err) {
      this.debug("Heatmap rasterization failed for", screen, err);
      // Don't un-set the fingerprint — repeated failures on the same
      // page would be wasted CPU. The next session retries naturally.
      return;
    }

    const base64 = dataUrl.split(",")[1];
    if (!base64) return;

    const body2 = JSON.stringify({
      screen_name: screen,
      app_version: this.appVersion,
      os: "web",
      device_width: Math.round(viewportWidth * (window.devicePixelRatio || 1)),
      device_height: Math.round(viewportHeight * (window.devicePixelRatio || 1)),
      scroll_offset_y: Math.round(window.scrollY || 0),
      image_base64: base64,
    });

    try {
      await fetch(`${this.endpoint.replace(/\/$/, "")}/api/heatmaps/snapshot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: body2,
        keepalive: true,
        credentials: "omit",
      });
      this.debug("📸 Heatmap snapshot uploaded for", screen);
    } catch (err) {
      this.debug("Heatmap snapshot upload failed for", screen, err);
    }
  }
}

function bucket(dim: number): number {
  // 60-pixel buckets — same as iOS/Android — so a one-pixel viewport
  // resize doesn't re-trigger capture.
  return Math.floor(dim / 60);
}

/**
 * Rasterizes the current viewport into a PNG data URL by serializing
 * the document into an SVG `<foreignObject>` and drawing it into a
 * canvas. Returns a data: URL on success, throws on failure.
 *
 * Cross-origin images and `<canvas>` elements taint the resulting
 * canvas under the same-origin policy — when that happens we throw
 * and the caller gives up silently. The dashboard's dimension-only
 * fallback continues to work.
 */
async function renderViewportToPng(width: number, height: number): Promise<string> {
  // Cap DPR at 2 to keep payload size sane. A 1440×900 viewport at
  // DPR 3 produces a ~12 MP raster which is way more than we need
  // for heatmap backdrops (the dashboard renders well under 1.5×).
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scaledW = Math.round(width * dpr);
  const scaledH = Math.round(height * dpr);

  // Clone the document body into a serializable form. We use
  // outerHTML on the documentElement so all <head> styles travel
  // with the snapshot — without them the foreignObject renders as
  // unstyled text.
  const html = await snapshotHtml();

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = `
    <svg xmlns="${svgNS}" width="${width}" height="${height}">
      <foreignObject width="100%" height="100%">
        ${html}
      </foreignObject>
    </svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = scaledW;
    canvas.height = scaledH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    // White background — many sites are transparent at the html
    // level and a black backdrop makes the heat dots unreadable.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, scaledW, scaledH);
    ctx.drawImage(img, 0, 0, scaledW, scaledH);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

/**
 * Serializes the document into an XHTML fragment safe to embed inside
 * an `<foreignObject>`. Avoids two foot-guns:
 *   1. Inline external stylesheet links — these wouldn't load inside
 *      the SVG sandbox, so we inline computed styles for body+html
 *      backgrounds. Full inlining of every rule is too expensive;
 *      modern apps lean heavily on inline styles anyway.
 *   2. Replace unencoded `&` in attribute values with `&amp;` so the
 *      XHTML parser inside the SVG doesn't choke.
 */
async function snapshotHtml(): Promise<string> {
  const docEl = document.documentElement;
  // Use the structured clone of outerHTML so we never modify the live
  // DOM, then wrap in a strict-namespaced fragment.
  const raw = docEl.outerHTML;
  // <foreignObject> requires an XHTML root, not the HTML5 doctype.
  // The xmlns attribute is mandatory.
  const xhtmlNS = "http://www.w3.org/1999/xhtml";
  // Inject xmlns onto the root html tag and escape stray ampersands.
  const safe = raw
    .replace(/^<html/i, `<html xmlns="${xhtmlNS}"`)
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, "&amp;");
  return safe;
}
