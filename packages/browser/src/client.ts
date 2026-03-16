import { createPersistentQueue } from "./storage";
import type {
  PersistentQueue,
  SankofaAliasPayload,
  SankofaAutocaptureOptions,
  SankofaBatchOperation,
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaInitOptions,
  SankofaPeoplePayload,
  SankofaPlugin,
  SankofaPluginContext,
  SankofaPluginInstance,
  SankofaPropertyMap,
  SankofaTrackPayload,
} from "./types";
import {
  SANKOFA_BROWSER_VERSION,
  SESSION_TIMEOUT_MS,
  hashString,
  randomId,
  resolveBatchUrl,
  resolveReplayChunkUrl,
  serializeTransportProperties,
} from "./utils";

type SessionState = {
  id: string;
  lastActivityAt: number;
};

type QueuedAnalyticsOperation = {
  type: SankofaBatchOperation["type"];
  payload: SankofaTrackPayload | SankofaPeoplePayload | SankofaAliasPayload;
  queuedAt: string;
};

type HistoryPatch = {
  originalPushState: History["pushState"];
  originalReplaceState: History["replaceState"];
  popstateListener: () => void;
};

type ActivityListener = {
  target: Window | Document;
  type: string;
  listener: EventListener;
  options?: AddEventListenerOptions;
};

const MAX_BATCH_SIZE = 100;
const USER_ACTIVITY_TOUCH_THROTTLE_MS = 15_000;

export class SankofaBrowserClient {
  private apiKey: string | null = null;
  private batchUrl: URL | null = null;
  private replayChunkUrl: URL | null = null;
  private analyticsQueue: PersistentQueue<QueuedAnalyticsOperation> | null = null;
  private storagePrefix = "sankofa:browser";
  private debugEnabled = false;
  private flushIntervalMs = 5_000;
  private intervalId: number | null = null;
  private historyPatch: HistoryPatch | null = null;
  private visibilityListener: (() => void) | null = null;
  private pagehideListener: ((event: PageTransitionEvent) => void) | null = null;
  private plugins: SankofaPluginInstance[] = [];
  private flushInFlight: Promise<void> | null = null;
  private needsAnotherFlush = false;
  private autocapture: SankofaAutocaptureOptions = { pageviews: true };
  private activityListeners: ActivityListener[] = [];
  private lastActivityTouchAt = 0;
  private sessionStateCache: SessionState | null = null;

  async init(options: SankofaInitOptions): Promise<SankofaBrowserClient> {
    if (typeof window === "undefined") {
      throw new Error("@sankofa/browser can only be initialized in the browser.");
    }

    await this.shutdown();

    this.apiKey = options.apiKey.trim();
    this.batchUrl = resolveBatchUrl(options.endpoint);
    this.replayChunkUrl = resolveReplayChunkUrl(options.endpoint);
    this.debugEnabled = Boolean(options.debug);
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.autocapture = normalizeAutocapture(options.autocapture);
    this.storagePrefix = `sankofa:${hashString(
      `${this.batchUrl.origin}|${this.batchUrl.pathname}|${this.apiKey}`,
    )}`;
    this.analyticsQueue = createPersistentQueue<QueuedAnalyticsOperation>({
      dbName: `${this.storagePrefix}:analytics`,
      storeName: "operations",
    });

    this.ensureIdentityState();
    this.touchSession("init");

    this.intervalId = window.setInterval(() => {
      void this.flush({
        reason: "timer",
      });
    }, this.flushIntervalMs);

    this.attachLifecycleListeners();
    this.attachActivityListeners();
    this.plugins = await this.setupPlugins(options.plugins ?? []);

    if (this.autocapture.pageviews) {
      this.installHistoryTracking();
      await this.capturePageView("initial");
    }

    this.debug("Initialized browser SDK", this.getSnapshot());
    return this;
  }

  async track(eventName: string, properties: SankofaPropertyMap = {}): Promise<void> {
    this.assertReady();
    const snapshot = this.touchSession("track");

    const payload: SankofaTrackPayload = {
      event_name: eventName,
      distinct_id: snapshot.distinctId,
      properties: {
        $session_id: snapshot.sessionId,
        ...serializeTransportProperties(properties),
      },
      default_properties: this.buildDefaultProperties(),
      timestamp: new Date().toISOString(),
      lib_version: snapshot.libVersion,
    };

    await this.enqueueOperation({
      type: "track",
      payload,
    });
  }

  async identify(userId: string, traits?: SankofaPropertyMap): Promise<void> {
    this.assertReady();
    const trimmedUserId = userId.trim();
    if (!trimmedUserId) {
      return;
    }

    const previous = this.getSnapshot();
    if (previous.distinctId === trimmedUserId) {
      if (traits && Object.keys(traits).length > 0) {
        await this.peopleSet(traits);
      }
      return;
    }

    const anonymousId = this.readLocalStorage("anonymous_id") ?? previous.anonymousId;
    this.writeLocalStorage("identified_id", trimmedUserId);
    this.writeLocalStorage("current_distinct_id", trimmedUserId);

    const next = this.getSnapshot();
    await this.notifyDistinctIdChange(next, previous);

    if (previous.distinctId === anonymousId && previous.distinctId !== trimmedUserId) {
      await this.enqueueOperation({
        type: "alias",
        payload: {
          alias_id: previous.distinctId,
          distinct_id: trimmedUserId,
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (traits && Object.keys(traits).length > 0) {
      await this.enqueueOperation({
        type: "people",
        payload: {
          distinct_id: trimmedUserId,
          properties: serializeTransportProperties(traits),
          timestamp: new Date().toISOString(),
        },
      });
    }

    await this.flush({
      reason: "identify",
    });
  }

  async peopleSet(traits: SankofaPropertyMap): Promise<void> {
    this.assertReady();
    const snapshot = this.touchSession("people");

    await this.enqueueOperation({
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

    await this.flush({
      reason: "reset",
    });

    const nextAnonymousId = randomId("anon_");
    this.writeLocalStorage("anonymous_id", nextAnonymousId);
    this.removeLocalStorage("identified_id");
    this.writeLocalStorage("current_distinct_id", nextAnonymousId);

    const nextSession: SessionState = {
      id: randomId("sess_"),
      lastActivityAt: Date.now(),
    };
    this.writeSessionState(nextSession);

    const current = this.getSnapshot();
    await this.notifyDistinctIdChange(current, previous);
    await this.notifySessionChange(current, previous);
  }

  async flush(options: SankofaFlushOptions = {}): Promise<void> {
    const apiKey = this.apiKey;
    const batchUrl = this.batchUrl;
    const analyticsQueue = this.analyticsQueue;

    if (!apiKey || !batchUrl || !analyticsQueue) {
      return;
    }

    if (this.flushInFlight) {
      this.needsAnotherFlush = true;
      return this.flushInFlight;
    }

    this.flushInFlight = (async () => {
      do {
        this.needsAnotherFlush = false;

        await Promise.all(
          this.plugins.map(async (plugin) => {
            try {
              if (plugin.flush) {
                await plugin.flush(options);
              }
            } catch (error) {
              this.debug("Plugin flush failed", error);
            }
          }),
        );

        let rows = await analyticsQueue.getAll(MAX_BATCH_SIZE);
        while (rows.length > 0) {
          const body = JSON.stringify({
            operations: rows.map((row) => ({
              type: row.value.type,
              payload: row.value.payload,
            })),
          });

          const response = await fetch(batchUrl.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
            body,
            keepalive: Boolean(options.keepalive),
          }).catch((error: unknown) => {
            this.debug("Analytics batch flush failed", error);
            return null;
          });

          if (!response) {
            break;
          }

          if (!response.ok) {
            this.debug(
              `Analytics batch flush failed with ${response.status} ${response.statusText}`,
              {
                reason: options.reason ?? "unknown",
                url: batchUrl.toString(),
              },
            );
            break;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const ack = await response.clone().json().catch(() => null);
            if (ack) {
              this.debug("Analytics batch flushed", ack);
            }
          }

          await analyticsQueue.deleteMany(rows.map((row) => row.id));
          rows = await analyticsQueue.getAll(MAX_BATCH_SIZE);
        }
      } while (this.needsAnotherFlush);
    })();

    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this.intervalId !== null && typeof window !== "undefined") {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.removeLifecycleListeners();
    this.removeActivityListeners();
    this.uninstallHistoryTracking();

    if (this.plugins.length > 0) {
      await Promise.all(
        this.plugins.map(async (plugin) => {
          try {
            if (plugin.shutdown) {
              await plugin.shutdown();
            }
          } catch (error) {
            this.debug("Plugin shutdown failed", error);
          }
        }),
      );
    }

    this.plugins = [];
    this.flushInFlight = null;
    this.needsAnotherFlush = false;
    this.lastActivityTouchAt = 0;
  }

  getSnapshot(): SankofaClientSnapshot {
    this.assertReady();
    const anonymousId = this.readLocalStorage("anonymous_id") ?? randomId("anon_");
    const identifiedId = this.readLocalStorage("identified_id");
    const distinctId =
      this.readLocalStorage("current_distinct_id") ?? identifiedId ?? anonymousId;
    const session = this.readSessionState() ?? {
      id: randomId("sess_"),
      lastActivityAt: Date.now(),
    };

    return {
      apiKey: this.apiKey!,
      batchUrl: this.batchUrl!.toString(),
      replayChunkUrl: this.replayChunkUrl!.toString(),
      distinctId,
      anonymousId,
      identifiedId,
      sessionId: session.id,
      libVersion: SANKOFA_BROWSER_VERSION,
      projectNamespace: this.storagePrefix,
    };
  }

  touchSession(source = "activity"): SankofaClientSnapshot {
    this.assertReady();
    const now = Date.now();
    const previous = this.getSnapshot();
    const currentSession = this.readSessionState();

    let nextSession = currentSession;
    if (!nextSession || now - nextSession.lastActivityAt > SESSION_TIMEOUT_MS) {
      nextSession = {
        id: randomId("sess_"),
        lastActivityAt: now,
      };
    } else {
      nextSession = {
        ...nextSession,
        lastActivityAt: now,
      };
    }

    this.writeSessionState(nextSession);
    this.lastActivityTouchAt = now;
    const current = this.getSnapshot();

    if (previous.sessionId !== current.sessionId) {
      void this.notifySessionChange(current, previous);
      this.debug(`Session rotated from ${previous.sessionId} to ${current.sessionId}`, source);
    }

    return current;
  }

  debug(message: string, ...details: unknown[]): void {
    if (this.debugEnabled) {
      console.debug("[Sankofa]", message, ...details);
    }
  }

  private async setupPlugins(plugins: SankofaPlugin[]): Promise<SankofaPluginInstance[]> {
    if (plugins.length === 0) {
      return [];
    }

    const context: SankofaPluginContext = {
      debug: (message, ...details) => this.debug(message, ...details),
      getSnapshot: () => this.getSnapshot(),
      touchSession: (source) => this.touchSession(source),
    };

    const instances = await Promise.all(
      plugins.map(async (plugin) => {
        try {
          const instance = await plugin.setup(context);
          this.debug(`Plugin ready: ${plugin.name}`);
          return instance ?? {};
        } catch (error) {
          this.debug(`Plugin setup failed: ${plugin.name}`, error);
          return {};
        }
      }),
    );

    return instances;
  }

  private async capturePageView(source: "initial" | "history"): Promise<void> {
    if (typeof window === "undefined") {
      return;
    }

    await this.track("$pageview", {
      source,
      title: document.title,
      path: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      url: window.location.href,
      referrer: document.referrer || "",
    });
  }

  private installHistoryTracking(): void {
    if (typeof window === "undefined" || this.historyPatch) {
      return;
    }

    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);

    const emitPageView = () => {
      void this.capturePageView("history");
    };

    window.history.pushState = ((...args: Parameters<History["pushState"]>) => {
      originalPushState(...args);
      emitPageView();
    }) as History["pushState"];

    window.history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      originalReplaceState(...args);
      emitPageView();
    }) as History["replaceState"];

    const popstateListener = () => emitPageView();
    window.addEventListener("popstate", popstateListener);

    this.historyPatch = {
      originalPushState,
      originalReplaceState,
      popstateListener,
    };
  }

  private uninstallHistoryTracking(): void {
    if (typeof window === "undefined" || !this.historyPatch) {
      return;
    }

    window.history.pushState = this.historyPatch.originalPushState;
    window.history.replaceState = this.historyPatch.originalReplaceState;
    window.removeEventListener("popstate", this.historyPatch.popstateListener);
    this.historyPatch = null;
  }

  private attachLifecycleListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    this.visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        void this.flush({
          keepalive: true,
          reason: "visibilitychange",
        });
        return;
      }

      this.observeActivity("visibilitychange");
    };

    this.pagehideListener = () => {
      void this.flush({
        keepalive: true,
        reason: "pagehide",
      });
    };

    document.addEventListener("visibilitychange", this.visibilityListener);
    window.addEventListener("pagehide", this.pagehideListener);
  }

  private removeLifecycleListeners(): void {
    if (typeof document !== "undefined" && this.visibilityListener) {
      document.removeEventListener("visibilitychange", this.visibilityListener);
      this.visibilityListener = null;
    }

    if (typeof window !== "undefined" && this.pagehideListener) {
      window.removeEventListener("pagehide", this.pagehideListener);
      this.pagehideListener = null;
    }
  }

  private ensureIdentityState(): void {
    const anonymousId = this.readLocalStorage("anonymous_id") ?? randomId("anon_");
    const identifiedId = this.readLocalStorage("identified_id");
    const currentDistinctId =
      this.readLocalStorage("current_distinct_id") ?? identifiedId ?? anonymousId;

    this.writeLocalStorage("anonymous_id", anonymousId);
    this.writeLocalStorage("current_distinct_id", currentDistinctId);
  }

  private attachActivityListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    if (this.activityListeners.length > 0) {
      return;
    }

    const register = (
      target: Window | Document,
      type: string,
      options?: AddEventListenerOptions,
    ) => {
      const listener: EventListener = () => {
        this.observeActivity(type);
      };
      target.addEventListener(type, listener, options);
      this.activityListeners.push({ target, type, listener, options });
    };

    register(window, "focus");
    register(window, "pointerdown", { passive: true });
    register(window, "keydown");
    register(window, "scroll", { passive: true });
    register(document, "click", { passive: true });
  }

  private removeActivityListeners(): void {
    this.activityListeners.forEach(({ target, type, listener, options }) => {
      target.removeEventListener(type, listener, options);
    });
    this.activityListeners = [];
  }

  private observeActivity(source: string): SankofaClientSnapshot {
    this.assertReady();
    const now = Date.now();
    const currentSession = this.readSessionState();

    if (!currentSession || now - currentSession.lastActivityAt > SESSION_TIMEOUT_MS) {
      return this.touchSession(source);
    }

    if (now - this.lastActivityTouchAt < USER_ACTIVITY_TOUCH_THROTTLE_MS) {
      return this.getSnapshot();
    }

    return this.touchSession(source);
  }

  private buildDefaultProperties(): Record<string, string> {
    if (typeof window === "undefined") {
      return {};
    }

    const navigatorWithUAData = navigator as Navigator & {
      userAgentData?: {
        platform?: string;
      };
    };

    const properties: Record<string, string> = {
      $lib: "sankofa-browser",
      $screen_width: String(window.screen.width),
      $screen_height: String(window.screen.height),
      $viewport_width: String(window.innerWidth),
      $viewport_height: String(window.innerHeight),
      $language: navigator.language || "",
      $platform: navigatorWithUAData.userAgentData?.platform ?? navigator.platform ?? "",
      $user_agent: navigator.userAgent ?? "",
      $referrer: document.referrer || "",
      $pathname: window.location.pathname,
      $current_url: window.location.href,
      $timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    };

    return properties;
  }

  private async enqueueOperation(operation: SankofaBatchOperation): Promise<void> {
    if (!this.analyticsQueue) {
      return;
    }

    await this.analyticsQueue.add({
      type: operation.type,
      payload: operation.payload,
      queuedAt: new Date().toISOString(),
    });
  }

  private async notifyDistinctIdChange(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.onDistinctIdChange) {
            await plugin.onDistinctIdChange(current, previous);
          }
        } catch (error) {
          this.debug("Plugin distinct ID change hook failed", error);
        }
      }),
    );
  }

  private async notifySessionChange(
    current: SankofaClientSnapshot,
    previous: SankofaClientSnapshot,
  ): Promise<void> {
    await Promise.all(
      this.plugins.map(async (plugin) => {
        try {
          if (plugin.onSessionChange) {
            await plugin.onSessionChange(current, previous);
          }
        } catch (error) {
          this.debug("Plugin session change hook failed", error);
        }
      }),
    );
  }

  private storageKey(name: string): string {
    return `${this.storagePrefix}:${name}`;
  }

  private readLocalStorage(name: string): string | null {
    try {
      return window.localStorage.getItem(this.storageKey(name));
    } catch {
      return null;
    }
  }

  private writeLocalStorage(name: string, value: string): void {
    try {
      window.localStorage.setItem(this.storageKey(name), value);
    } catch {
      this.debug(`Failed to persist localStorage key ${name}`);
    }
  }

  private removeLocalStorage(name: string): void {
    try {
      window.localStorage.removeItem(this.storageKey(name));
    } catch {
      this.debug(`Failed to clear localStorage key ${name}`);
    }
  }

  private readSessionState(): SessionState | null {
    try {
      const rawValue =
        window.localStorage.getItem(this.storageKey("session")) ??
        window.sessionStorage.getItem(this.storageKey("session"));
      if (!rawValue) {
        return this.sessionStateCache;
      }

      const parsed = JSON.parse(rawValue) as Partial<SessionState>;
      if (typeof parsed.id !== "string" || typeof parsed.lastActivityAt !== "number") {
        return this.sessionStateCache;
      }

      const state = {
        id: parsed.id,
        lastActivityAt: parsed.lastActivityAt,
      };
      this.sessionStateCache = state;
      return state;
    } catch {
      return this.sessionStateCache;
    }
  }

  private writeSessionState(value: SessionState): void {
    this.sessionStateCache = value;
    try {
      window.localStorage.setItem(this.storageKey("session"), JSON.stringify(value));
    } catch {
      this.debug("Failed to persist localStorage session state");
    }

    try {
      window.sessionStorage.setItem(this.storageKey("session"), JSON.stringify(value));
    } catch {
      this.debug("Failed to persist session state");
    }
  }

  private assertReady(): void {
    if (!this.apiKey || !this.batchUrl || !this.replayChunkUrl) {
      throw new Error("Sankofa has not been initialized yet.");
    }
  }
}

function normalizeAutocapture(
  autocapture: SankofaInitOptions["autocapture"],
): SankofaAutocaptureOptions {
  if (typeof autocapture === "boolean") {
    return {
      pageviews: autocapture,
    };
  }

  return {
    pageviews: autocapture?.pageviews ?? true,
  };
}
