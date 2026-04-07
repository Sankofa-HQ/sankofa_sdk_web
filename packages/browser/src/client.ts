import { SankofaActivityObserver } from "./activity";
import { SankofaAutocapture } from "./autocapture";
import { SankofaIdentity } from "./identity";
import { SankofaLifecycleObserver } from "./lifecycle";
import { SankofaPluginManager } from "./plugins";
import { SankofaQueueManager } from "./queue";
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
  resolveReplayChunkUrl,
  resolveReplayConfigUrl,
  serializeTransportProperties,
} from "./utils";

export class SankofaBrowserClient {
  private props: {
    apiKey: string | null;
    batchUrl: URL | null;
    replayChunkUrl: URL | null;
    replayConfigUrl: URL | null;
    storagePrefix: string;
    debug: boolean;
  } = {
    apiKey: null,
    batchUrl: null,
    replayChunkUrl: null,
    replayConfigUrl: null,
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
    this.props.replayChunkUrl = resolveReplayChunkUrl(options.endpoint);
    this.props.replayConfigUrl = resolveReplayConfigUrl(options.endpoint);
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

    // Remote Configuration Sync
    try {
      this.replayConfig = await this.fetchReplayConfig();
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
    return this;
  }

  /**
   * Explicitly tag the screen the user is currently viewing.
   * Crucial for building accurate Heatmaps in the Dashboard.
   */
  async screen(screenName: string, properties: SankofaPropertyMap = {}): Promise<void> {
    this._currentScreen = screenName;
    this._isManualScreen = true;
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
    await this.track("$pageview", {
      $pageview_source: source,
      $pathname: window.location.pathname,
      $current_url: window.location.href,
    });
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

    // Check for High Fidelity Triggers
    if (this.replayConfig && this.replayConfig.high_fidelity_triggers.includes(eventName)) {
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
      distinctId: idState.distinctId,
      anonymousId: idState.anonymousId,
      identifiedId: idState.identifiedId,
      sessionId: session.id,
      currentScreen: this._currentScreen,
      libVersion: SANKOFA_BROWSER_VERSION,
      projectNamespace: this.props.storagePrefix,
    };
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
