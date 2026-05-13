import { SankofaActivityObserver } from "./activity";
import { SankofaAutocapture } from "./autocapture";
import { HeatmapSnapshotter } from "./heatmap-snapshotter";
import { SankofaIdentity } from "./identity";
import { SankofaLifecycleObserver } from "./lifecycle";
import { SankofaPluginManager } from "./plugins";
import { SankofaPresenceHeartbeat } from "./presence";
import {
  SankofaQueueManager,
  type TransportListener,
  type TransportStatus,
} from "./queue";
import { SankofaSessionManager } from "./session";
import type {
  SankofaAutocaptureOptions,
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaInitOptions,
  SankofaPropertyMap,
  SankofaReplayConfig,
  SankofaTrackPayload,
} from "./types";
import {
  SANKOFA_BROWSER_VERSION,
  hashString,
  resolveBatchUrl,
  resolveCatchIngestUrl,
  resolveHandshakeUrl,
  resolveReplayChunkUrl,
  resolveReplayConfigUrl,
  resolveSwitchExposuresUrl,
  serializeTransportProperties,
} from "./utils";

export class SankofaBrowserClient {
  private props: {
    apiKey: string | null;
    batchUrl: URL | null;
    handshakeUrl: URL | null;
    replayChunkUrl: URL | null;
    replayConfigUrl: URL | null;
    switchExposuresUrl: URL | null;
    catchIngestUrl: URL | null;
    storagePrefix: string;
    debug: boolean;
  } = {
    apiKey: null,
    batchUrl: null,
    handshakeUrl: null,
    replayChunkUrl: null,
    replayConfigUrl: null,
    switchExposuresUrl: null,
    catchIngestUrl: null,
    storagePrefix: "sankofa:browser",
    debug: false,
  };
  private replayConfig: SankofaReplayConfig | null = null;

  private identity!: SankofaIdentity;
  private session!: SankofaSessionManager;
  private queue!: SankofaQueueManager;
  private autocapture!: SankofaAutocapture;
  private activity!: SankofaActivityObserver;
  private plugins!: SankofaPluginManager;
  private lifecycle!: SankofaLifecycleObserver;
  private presence: SankofaPresenceHeartbeat | null = null;
  /** Dedicated heatmap-background snapshotter. Independent of rrweb —
   *  fires one stability-gated SVG-foreignObject rasterization per
   *  `(screen, viewport-bucket)` per session so the dashboard's
   *  heatmap renders over a real screenshot instead of a blank
   *  dimension-only placeholder. */
  private heatmapSnapshotter: HeatmapSnapshotter | null = null;

  private flushIntervalMs = 5_000;
  private intervalId: number | null = null;
  private _isInitialized = false;
  private _currentScreen = "Unknown";
  private _isManualScreen = false;

  async init(options: SankofaInitOptions): Promise<SankofaBrowserClient> {
    if (typeof window === "undefined") {
      throw new Error("@sankofa/browser can only be initialized in the browser.");
    }

    await this.shutdown();

    this.props.apiKey = options.apiKey.trim();
    this.props.batchUrl = resolveBatchUrl(options.endpoint);
    this.props.handshakeUrl = resolveHandshakeUrl(options.endpoint);
    this.props.replayChunkUrl = resolveReplayChunkUrl(options.endpoint);
    this.props.replayConfigUrl = resolveReplayConfigUrl(options.endpoint);
    this.props.switchExposuresUrl = resolveSwitchExposuresUrl(options.endpoint);
    this.props.catchIngestUrl = resolveCatchIngestUrl(options.endpoint);
    this.props.debug = Boolean(options.debug);
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.props.storagePrefix = `sankofa:${hashString(
      `${this.props.batchUrl.origin}|${this.props.batchUrl.pathname}|${this.props.apiKey}`,
    )}`;

    // Initialize Modules
    this.identity = new SankofaIdentity({ prefix: this.props.storagePrefix });
    this.session = new SankofaSessionManager({ prefix: this.props.storagePrefix });
    this.queue = new SankofaQueueManager({
      apiKey: this.props.apiKey,
      batchUrl: this.props.batchUrl,
      storagePrefix: this.props.storagePrefix,
      debug: (msg, ...details) => this.debug(msg, ...details),
    });
    this.plugins = new SankofaPluginManager({
      debug: (msg, ...details) => this.debug(msg, ...details),
    });
    this.autocapture = new SankofaAutocapture({
      onPageView: (source) => this.capturePageView(source),
    });
    this.activity = new SankofaActivityObserver({
      onActivity: (source) => this.touchSession(source),
    });
    this.lifecycle = new SankofaLifecycleObserver({
      onFlush: (opts) => this.flush(opts),
      onTrack: (name, props) => this.track(name, props),
      session: this.session,
    });

    const autocaptureOpts = normalizeAutocapture(options.autocapture);
    if (autocaptureOpts.pageviews) {
      this.autocapture.install();
    }

    // ── Pre-register plugin module names (before handshake) ──
    // The Traffic Cop needs to know which canonical modules have a
    // plugin BEFORE the handshake fetch — otherwise `routeHandshake`
    // sees an empty registry and warns "no plugin" for every module.
    // We pre-register the module names (the lightweight `moduleName`
    // declaration on each plugin) here; full plugin setup still runs
    // AFTER the handshake so replay plugins can read `replayConfig`
    // from their setup context.
    this.plugins.preregisterModules(options.plugins ?? []);

    // ── Unified Handshake ──
    // One call to /api/v1/handshake returns config for ALL Sankofa
    // products. Falls back to legacy /api/replay/config on older servers.
    // Traffic Cop module routing happens after full plugin setup below.
    let handshakeModules: Record<string, any> | null = null;
    try {
      handshakeModules = await this.fetchHandshake();
      if (handshakeModules?.replay) {
        this.replayConfig = handshakeModules.replay as SankofaReplayConfig;
      } else {
        this.replayConfig = await this.fetchReplayConfig();
      }
    } catch (error) {
      this.debug("Failed to fetch remote config, using defaults", error);
    }

    await this.plugins.setup(options.plugins ?? [], {
      debug: (msg, ...details) => this.debug(msg, ...details),
      getSnapshot: () => this.getSnapshot(),
      touchSession: (source) => this.touchSession(source),
      replayConfig: this.replayConfig ?? undefined,
      triggerHighFidelity: () => this.plugins.notifyHighFidelity(),
    });

    // Traffic Cop — now that plugins are fully registered, dispatch the
    // handshake-driven module flags to them. Runs as a no-op for modules
    // without a corresponding plugin (with a dev warning).
    await this.plugins.routeHandshake(handshakeModules);

    this.intervalId = window.setInterval(() => {
      void this.flush({ reason: "timer" });
    }, this.flushIntervalMs);

    // 🚀 Session Lifecycle Boot
    const { rotated } = this.session.refresh();
    
    // First Time Open Logic
    const firstOpenKey = `${this.props.storagePrefix}:first_open`;
    if (!localStorage.getItem(firstOpenKey)) {
        localStorage.setItem(firstOpenKey, "true");
        await this.track("$app_open_first_time");
    }

    if (rotated) {
        await this.track("$session_start");
    }

    this._isInitialized = true;
    this.debug("Initialized browser SDK", this.getSnapshot());

    this.lifecycle.install();

    // Live-presence heartbeat — independent of analytics flush so it
    // ticks at its own cadence (15s) while the tab is visible. Cheap:
    // one tiny POST per interval, paused when backgrounded.
    this.presence = new SankofaPresenceHeartbeat({
      batchUrl: this.props.batchUrl!,
      apiKey: this.props.apiKey!,
      getSnapshot: () => {
        const s = this.getSnapshot();
        return {
          distinctId: s.distinctId,
          sessionId: s.sessionId,
          currentScreen: s.currentScreen,
        };
      },
      debug: (msg, ...rest) => this.debug(msg, ...rest),
    });
    this.presence.start();

    // Dedicated heatmap snapshotter — fires one stability-gated DOM
    // raster per (screen, viewport-bucket) so the dashboard's heatmap
    // renders over a real backdrop instead of the dimension-only
    // placeholder that the rrweb chunk path produces.
    this.heatmapSnapshotter = new HeatmapSnapshotter({
      endpoint: this.props.batchUrl!.origin,
      apiKey: this.props.apiKey!,
      appVersion:
        (typeof window !== "undefined" && (window as Window & { __APP_VERSION__?: string }).__APP_VERSION__) ||
        "unknown",
      debug: (msg, ...rest) => this.debug(String(msg), ...rest),
    });
    // Fire an initial capture for whatever screen tag is current at
    // bootstrap. Subsequent screen() / pageview triggers are wired
    // into those code paths directly.
    if (this._currentScreen && this._currentScreen !== "Unknown") {
      this.heatmapSnapshotter.scheduleCapture(this._currentScreen);
    }

    return this;
  }

  /**
   * Explicitly tag the screen the user is currently viewing.
   * Crucial for building accurate Heatmaps in the Dashboard.
   */
  async screen(screenName: string, properties: SankofaPropertyMap = {}): Promise<void> {
    this._currentScreen = screenName;
    this._isManualScreen = true;
    // Canonical screen signal — fires regardless of which Sankofa
    // products the host has enabled, so the lexicon + dwell + presence
    // are always populated.
    this.emitScreenSeen(screenName, properties);
    // Stability-gated heatmap snapshot. Deduped inside the
    // snapshotter — repeated screen() calls on the same view are
    // no-ops.
    this.heatmapSnapshotter?.scheduleCapture(screenName);
    await this.track("$screen_view", { ...properties, $screen_name: screenName });
  }

  /**
   * Auto-pageview hook fired by SankofaAutocapture on initial load and SPA
   * history navigation.  When the host app has not called `screen()` manually,
   * we use the current pathname as a best-effort screen tag so heatmap
   * attribution still works out of the box.
   */
  private async capturePageView(source: "initial" | "history"): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this._isManualScreen) {
      this._currentScreen = window.location.pathname || "/";
    }
    // Auto-detected screens still fire the canonical signal so the
    // lexicon + dwell flow even for hosts that never call screen()
    // manually.
    this.emitScreenSeen(this._currentScreen, {
      $auto_detected: true,
      $pageview_source: source,
    });
    // Schedule a heatmap snapshot for the (possibly-auto-detected)
    // screen. Dedupe inside the snapshotter prevents re-uploading
    // on SPA route-change spam.
    this.heatmapSnapshotter?.scheduleCapture(this._currentScreen);
    await this.track("$pageview", {
      $pageview_source: source,
      $pathname: window.location.pathname,
      $current_url: window.location.href,
    });
  }

  /**
   * Fire-and-forget POST to the canonical /api/v1/screens/seen
   * endpoint. Idempotent server-side; failures are silent — screen
   * tagging is decorative for cross-product correlation, never
   * load-bearing for the analytics payload.
   */
  private emitScreenSeen(screenName: string, properties: SankofaPropertyMap): void {
    if (!this._isInitialized) return;
    if (!this.props.batchUrl || !this.props.apiKey) return;
    if (!screenName) return;

    const url = `${this.props.batchUrl.origin}/api/v1/screens/seen`;
    const snap = this.getSnapshot();
    const body = JSON.stringify({
      screen: screenName,
      distinct_id: snap.distinctId,
      session_id: snap.sessionId,
      ts_ms: Date.now(),
      properties,
    });
    try {
      void fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.props.apiKey,
        },
        body,
        credentials: "omit",
        keepalive: true,
      });
    } catch (err) {
      this.debug("screens/seen failed", err);
    }
  }

  async track(eventName: string, properties: SankofaPropertyMap = {}): Promise<void> {
    const isFirstEvents = ["$app_open_first_time", "$session_start"].includes(eventName);
    if (!this._isInitialized && !isFirstEvents) {
      this.debug("❌ Sankofa.track() called before init()");
      return;
    }
    
    const snapshot = this.getSnapshot();

    const payload: SankofaTrackPayload = {
      event_name: eventName,
      distinct_id: snapshot.distinctId,
      properties: serializeTransportProperties({
        $session_id: snapshot.sessionId,
        $screen_name: this._currentScreen,
        ...properties,
      }),
      default_properties: this.buildDefaultProperties(),
      timestamp: new Date().toISOString(),
      lib_version: snapshot.libVersion,
    };

    await this.queue.enqueue({ type: "track", payload });
    this.debug(`📝 Tracked: ${eventName}`);

    // Check for High Fidelity Triggers. The handshake may omit
    // `high_fidelity_triggers` entirely (older servers, replay disabled),
    // so optional-chain through both fields rather than asserting shape.
    if (this.replayConfig?.high_fidelity_triggers?.includes(eventName)) {
        this.debug(`🚀 High Fidelity Trigger fired: ${eventName}`);
        void this.plugins.notifyHighFidelity();
    }
  }

  async identify(userId: string, traits?: SankofaPropertyMap): Promise<void> {
    this.assertReady();
    const previous = this.getSnapshot();
    this.identity.identify(userId);
    const current = this.getSnapshot();

    if (previous.distinctId !== current.distinctId) {
      await this.plugins.notifyDistinctIdChange(current, previous);

      if (previous.distinctId === previous.anonymousId) {
        await this.queue.enqueue({
          type: "alias",
          payload: {
            alias_id: previous.distinctId,
            distinct_id: current.distinctId,
            timestamp: new Date().toISOString(),
          },
        });
      }
    }

    if (traits && Object.keys(traits).length > 0) {
      await this.peopleSet(traits);
    }

    await this.flush({ reason: "identify" });
  }

  async peopleSet(traits: SankofaPropertyMap): Promise<void> {
    this.assertReady();
    const snapshot = this.touchSession("people");

    await this.queue.enqueue({
      type: "people",
      payload: {
        distinct_id: snapshot.distinctId,
        properties: serializeTransportProperties(traits),
        timestamp: new Date().toISOString(),
      },
    });
  }

  async setPerson(
    properties: { name?: string; email?: string; avatar?: string } & SankofaPropertyMap,
  ): Promise<void> {
    const { name, email, avatar, ...rest } = properties;
    const traits: SankofaPropertyMap = { ...rest };
    if (name !== undefined) traits["$name"] = name;
    if (email !== undefined) traits["$email"] = email;
    if (avatar !== undefined) traits["$avatar"] = avatar;
    await this.peopleSet(traits);
  }

  async reset(): Promise<void> {
    this.assertReady();
    const previous = this.getSnapshot();

    await this.flush({ reason: "reset" });

    const idChange = this.identity.reset();
    const nextSession = this.session.startNewSession();

    const current = this.getSnapshot();
    await this.plugins.notifyDistinctIdChange(current, previous);
    await this.plugins.notifySessionChange(current, previous);
  }

  async flush(options: SankofaFlushOptions = {}): Promise<void> {
    if (!this._isInitialized) return;
    await this.plugins.flush(options);
    await this.queue.flush(options);
  }

  async shutdown(): Promise<void> {
    if (this.intervalId !== null && typeof window !== "undefined") {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.lifecycle) this.lifecycle.uninstall();
    if (this.activity) this.activity.uninstall();
    if (this.autocapture) this.autocapture.uninstall();
    if (this.presence) {
      this.presence.stop();
      this.presence = null;
    }
    if (this.plugins) await this.plugins.shutdown();

    this._isInitialized = false;
  }

  getSnapshot(): SankofaClientSnapshot {
    this.assertReady();
    const idState = this.identity.state;
    const session = this.session.state;

    return {
      apiKey: this.props.apiKey!,
      batchUrl: this.props.batchUrl!.toString(),
      replayChunkUrl: this.props.replayChunkUrl!.toString(),
      replayConfigUrl: this.props.replayConfigUrl!.toString(),
      switchExposuresUrl: this.props.switchExposuresUrl!.toString(),
      catchIngestUrl: this.props.catchIngestUrl!.toString(),
      distinctId: idState.distinctId,
      anonymousId: idState.anonymousId,
      identifiedId: idState.identifiedId,
      sessionId: session.id,
      currentScreen: this._currentScreen,
      libVersion: SANKOFA_BROWSER_VERSION,
      projectNamespace: this.props.storagePrefix,
    };
  }

  getTransportStatus(): TransportStatus | null {
    if (!this._isInitialized) return null;
    return this.queue.getStatus();
  }

  onTransportStatus(listener: TransportListener): () => void {
    if (!this._isInitialized) return () => {};
    return this.queue.onStatusChange(listener);
  }

  touchSession(source = "activity"): SankofaClientSnapshot {
    this.assertReady();
    const previous = this.getSnapshot();
    const { current: nextSession } = this.session.refresh();
    const current = this.getSnapshot();

    if (previous.sessionId !== current.sessionId) {
      void this.plugins.notifySessionChange(current, previous);
      this.debug(`Session rotated from ${previous.sessionId} to ${current.sessionId}`, source);
    }

    return current;
  }

  debug(message: string, ...details: unknown[]): void {
    if (this.props.debug) {
      console.debug("[Sankofa]", message, ...details);
    }
  }

  private buildDefaultProperties(): Record<string, string> {
    if (typeof window === "undefined") return {};

    const ua = navigator.userAgent;

    let os = "Other";
    if (/Windows/i.test(ua)) os = "Windows";
    else if (/Mac/i.test(ua)) os = "MacOS";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Linux/i.test(ua)) os = "Linux";

    let browser = "Other";
    if (/Chrome/i.test(ua)) browser = "Chrome";
    else if (/Safari/i.test(ua)) browser = "Safari";
    else if (/Firefox/i.test(ua)) browser = "Firefox";
    else if (/MSIE|Trident/i.test(ua)) browser = "Internet Explorer";
    else if (/Edge/i.test(ua)) browser = "Edge";

    const navigatorWithUAData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };

    return {
      $lib: "sankofa-browser",
      $os: os,
      $browser: browser,
      $screen_width: String(window.screen.width),
      $screen_height: String(window.screen.height),
      $screen_dpi: String(window.devicePixelRatio * 96), // Standard web DPI approximation
      $viewport_width: String(window.innerWidth),
      $viewport_height: String(window.innerHeight),
      $language: navigator.language || "",
      $platform: navigatorWithUAData.userAgentData?.platform ?? navigator.platform ?? "",
      $user_agent: ua,
      $referrer: document.referrer || "",
      $pathname: window.location.pathname,
      $current_url: window.location.href,
      $timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    };
  }

  private async fetchHandshake(): Promise<Record<string, any> | null> {
    const url = this.props.handshakeUrl;
    if (!url || !this.props.apiKey) return null;

    // Reverse Handshake: tell the server which canonical modules this
    // bundle ships with so the dashboard can gate UI for missing modules.
    // `sdk=web` identifies this as a browser/Node bundle for grouping.
    // Legacy SDKs (no `installed` param) default to "allow everything"
    // server-side — backward compatible.
    const installed = this.plugins.getInstalledModules().join(",");
    const urlWithInstalled = new URL(url.toString());
    urlWithInstalled.searchParams.set("installed", installed);
    urlWithInstalled.searchParams.set("sdk", "web");

    // ── Device context for Switch/Config targeting ──────────────────
    //
    // The server's evaluator needs `distinct_id` to bucket rollouts
    // deterministically, resolve cohort membership, and honor user
    // allow-lists. Without it every browser session looks identical
    // and the targeting engine falls back to "everyone matches the
    // empty bucket". Same goes for app version + platform for the
    // version-range + platform-specific conditions.
    const snap = this.getSnapshot();
    if (snap?.distinctId) {
      urlWithInstalled.searchParams.set("distinct_id", snap.distinctId);
    }
    // Identity stitching: post-identify sessions carry the pre-identify
    // anonymous id alongside the new distinct id so the server can
    // merge flag evaluations/exposures across the login boundary into a
    // single experiment subject. Skipped when the user has never been
    // identified (distinctId still === anonymousId) because anon_id
    // would be redundant.
    if (snap?.anonymousId && snap.distinctId !== snap.anonymousId) {
      urlWithInstalled.searchParams.set("anon_id", snap.anonymousId);
    }
    urlWithInstalled.searchParams.set("platform", "web");
    if (typeof navigator !== "undefined" && navigator.language) {
      urlWithInstalled.searchParams.set("locale", navigator.language);
    }
    // App version — fall back to the SDK lib version so the server's
    // semver comparisons always have something to work with. Host apps
    // that want precise version targeting should configure it via
    // `init({ appVersion })` when we add that option.
    const appVersion = SANKOFA_BROWSER_VERSION;
    if (appVersion) {
      urlWithInstalled.searchParams.set("app_version", appVersion);
    }

    // Stale-while-revalidate: the server emits a composite ETag over
    // every module that publishes one. We persist that etag + the last
    // modules payload so the next boot can restore instantly AND the
    // next refresh can send If-None-Match for a 304 when nothing has
    // changed. Private browsing / storage-full situations degrade
    // gracefully: we just don't hit the 304 path on those clients.
    const headers: Record<string, string> = { "x-api-key": this.props.apiKey };
    const cached = this.loadCachedHandshake();
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    const res = await fetch(urlWithInstalled.toString(), { headers }).catch(() => null);
    if (!res) {
      this.debug("🤝 Handshake unavailable, serving cached modules");
      return cached?.modules ?? null;
    }

    if (res.status === 304 && cached?.modules) {
      this.debug("🤝 Handshake 304 Not Modified — cached modules still current");
      return cached.modules;
    }

    if (res.ok) {
      const data = await res.json();
      const etag = res.headers.get("ETag") || "";
      this.debug("🤝 Handshake OK", data.project_id, "(installed:", installed, ")");
      if (data.modules) {
        this.saveCachedHandshake({ modules: data.modules, etag });
      }
      return data.modules ?? null;
    }

    this.debug("🤝 Handshake returned", res.status, "— falling back to cache");
    return cached?.modules ?? null;
  }

  // ── Handshake cache (last known modules + etag) ──────────────────
  //
  // Stored in localStorage under the client's per-project prefix so
  // each project/api-key pair has its own cache. Kept deliberately
  // simple — individual module plugins (switch, config) have their own
  // caches with their own change-detection logic; this one exists only
  // so the client can (a) send If-None-Match and (b) replay the last
  // handshake when the network is down at boot.

  private handshakeStorageKey(): string {
    return `${this.props.storagePrefix}:handshake`;
  }

  private loadCachedHandshake(): { modules: Record<string, any>; etag: string } | null {
    if (typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(this.handshakeStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { modules?: Record<string, any>; etag?: string; savedAt?: number };
      if (!parsed?.modules) return null;
      // Same 7-day stale guard as individual module caches so nothing
      // outlives the project's "we still trust cached config" window.
      if (parsed.savedAt && Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
      return { modules: parsed.modules, etag: parsed.etag || "" };
    } catch {
      return null;
    }
  }

  private saveCachedHandshake(payload: { modules: Record<string, any>; etag: string }): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.setItem(
        this.handshakeStorageKey(),
        JSON.stringify({ ...payload, savedAt: Date.now() }),
      );
    } catch {
      /* storage full or private mode — continue without persistence */
    }
  }

  private async fetchReplayConfig(): Promise<SankofaReplayConfig | null> {
    const url = this.props.replayConfigUrl;
    if (!url || !this.props.apiKey) return null;

    const res = await fetch(url.toString(), {
      headers: {
        "x-api-key": this.props.apiKey,
      },
    }).catch(() => null);

    if (res?.ok) {
      return (await res.json()) as SankofaReplayConfig;
    }
    return null;
  }

  private assertReady(): void {
    if (!this.props.apiKey || !this.props.batchUrl) {
      throw new Error("Sankofa has not been initialized yet.");
    }
  }
}

function normalizeAutocapture(
  autocapture: SankofaInitOptions["autocapture"],
): SankofaAutocaptureOptions {
  if (typeof autocapture === "boolean") {
    return { pageviews: autocapture };
  }
  return { pageviews: autocapture?.pageviews ?? true };
}
