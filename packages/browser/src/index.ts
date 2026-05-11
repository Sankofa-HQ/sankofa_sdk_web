import { SankofaBrowserClient } from "./client";
import { getModuleAPI } from "./module-registry";

// Duck-typed shape of `@sankofa/catch`'s SankofaCatchAPI. Defined
// inline so `@sankofa/browser` doesn't have to import from
// `@sankofa/catch` (catch already depends on browser; the reverse
// would create a cycle). The registry's contract is the only thing
// that matters at the call site — if the host hasn't registered
// catchPlugin, the registry returns null and every helper no-ops.
/**
 * Public scope handle handed to `Sankofa.withScope(fn)`. Mirrors
 * `SankofaCatchScope` in @sankofa/catch — re-declared here so
 * @sankofa/browser doesn't have to depend on @sankofa/catch (catch
 * already depends on browser; the reverse would create a cycle).
 *
 * The duck-typed shape works because at runtime the registry hands
 * back the same `SankofaScope` instance @sankofa/catch creates.
 */
export interface SankofaScope {
  setTag(key: string, value: string): SankofaScope;
  setTags(tags: Record<string, string>): SankofaScope;
  setExtra(key: string, value: unknown): SankofaScope;
  setUser(user: unknown): SankofaScope;
  setLevel(level: string): SankofaScope;
  setFingerprint(fingerprint: string[]): SankofaScope;
}
interface CatchAPILike {
  captureException(err: unknown, options?: unknown): string;
  captureMessage(message: string, options?: unknown): string;
  log(message: string, category?: string): void;
  addBreadcrumb(crumb: unknown): void;
  setUser(user: unknown): void;
  setTag(key: string, value: string): void;
  setTags(tags: Record<string, string>): void;
  setExtra(key: string, value: unknown): void;
  withScope<T>(fn: (scope: SankofaScope) => T): T;
  flush(): Promise<void>;
}
export { createPersistentQueue } from "./storage";
export type {
  PersistentQueue,
  QueuedRecord,
  SankofaAliasPayload,
  SankofaAutocaptureOptions,
  SankofaBatchOperation,
  SankofaClientSnapshot,
  SankofaFlushOptions,
  SankofaInitOptions,
  SankofaModuleName,
  SankofaPeoplePayload,
  SankofaPlugin,
  SankofaPluginContext,
  SankofaPluginInstance,
  SankofaPropertyMap,
  SankofaTrackPayload,
  SankofaTransportValue,
} from "./types";
export type { TransportStatus, TransportFailureKind, TransportListener } from "./queue";
export {
  registerModuleAPI,
  unregisterModuleAPI,
  getModuleAPI,
} from "./module-registry";
export {
  SANKOFA_BROWSER_VERSION,
  resolveBatchUrl,
  resolveReplayChunkUrl,
  resolveServerBaseUrl,
  resolveTrackUrl,
  resolveV1BaseUrl,
  serializeTransportProperties,
  serializeTransportValue,
} from "./utils";

const client = new SankofaBrowserClient();

export const Sankofa = {
  init(options: import("./types").SankofaInitOptions) {
    return client.init(options);
  },
  track(eventName: string, properties?: import("./types").SankofaPropertyMap) {
    return client.track(eventName, properties);
  },
  identify(userId: string, traits?: import("./types").SankofaPropertyMap) {
    return client.identify(userId, traits);
  },
  peopleSet(traits: import("./types").SankofaPropertyMap) {
    return client.peopleSet(traits);
  },
  setPerson(properties: { name?: string; email?: string; avatar?: string } & import("./types").SankofaPropertyMap) {
    return client.setPerson(properties);
  },
  reset() {
    return client.reset();
  },
  flush(options?: import("./types").SankofaFlushOptions) {
    return client.flush(options);
  },
  shutdown() {
    return client.shutdown();
  },
  getSnapshot() {
    return client.getSnapshot();
  },
  getTransportStatus() {
    return client.getTransportStatus();
  },
  onTransportStatus(listener: import("./queue").TransportListener) {
    return client.onTransportStatus(listener);
  },

  // ── Catch static helpers (Crashlytics + Sentry merged) ──────────
  //
  // Surface area pinned for parity with the Flutter / RN / Android /
  // iOS SDKs. Each helper degrades to a no-op when catchPlugin is not
  // registered (e.g. host didn't include @sankofa/catch in plugins[])
  // so call sites never need to guard `if (catchEnabled) ...`.

  /**
   * Capture a handled error. Returns the event ID, or `""` when Catch
   * is not loaded / disabled / sampled out.
   *
   * ```ts
   * try { risky() } catch (e) { Sankofa.captureException(e); }
   * ```
   */
  captureException(err: unknown, options?: unknown): string {
    const c = getModuleAPI<CatchAPILike>("catch");
    return c ? c.captureException(err, options) : "";
  },

  /**
   * Capture an arbitrary message — non-throwing variant of
   * `captureException`. Useful for non-fatal "this shouldn't happen"
   * branches.
   */
  captureMessage(message: string, options?: unknown): string {
    const c = getModuleAPI<CatchAPILike>("catch");
    return c ? c.captureMessage(message, options) : "";
  },

  /**
   * Crashlytics-style breadcrumb log. Drops a free-text trail entry
   * onto the ring buffer that rides on the next captured event.
   * Doesn't bill — no event is emitted unless something else captures.
   */
  log(message: string, category?: string): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.log(message, category);
  },

  /** Set ambient user context that's stamped on every subsequent capture. */
  setUser(user: unknown): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.setUser(user);
  },

  /** Set a single tag. */
  setTag(key: string, value: string): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.setTag(key, value);
  },

  /** Bulk-set tags — merges into the existing tag map. */
  setTags(tags: Record<string, string>): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.setTags(tags);
  },

  /** Attach extra context (arbitrary key/value) sent on every capture. */
  setExtra(key: string, value: unknown): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.setExtra(key, value);
  },

  /** Push a breadcrumb onto the ring buffer. Use `log()` for plain text. */
  addBreadcrumb(crumb: unknown): void {
    const c = getModuleAPI<CatchAPILike>("catch");
    c?.addBreadcrumb(crumb);
  },

  /**
   * Run `fn` with a temporary scope. Mutations made via the scope
   * (tags, extras, user, level, fingerprint) overlay onto any
   * `captureException` / `captureMessage` calls inside `fn`. Outside
   * `fn` the scope is gone — async captures deferred past `fn`'s
   * return will NOT see the scope.
   *
   * No-op when catchPlugin isn't loaded — `fn` still runs so host
   * code that does work alongside captures isn't skipped.
   *
   * ```ts
   * Sankofa.withScope((scope) => {
   *   scope.setTag('flow', 'checkout');
   *   scope.setExtra('cart_id', cart.id);
   *   Sankofa.captureException(err);
   * });
   * ```
   */
  withScope<T>(fn: (scope: SankofaScope) => T): T {
    const c = getModuleAPI<CatchAPILike>("catch");
    if (c) return c.withScope(fn);
    // No-catch fallback: hand back a sink-style scope so host code
    // doesn't have to guard the API.
    const noop: SankofaScope = {
      setTag: () => noop,
      setTags: () => noop,
      setExtra: () => noop,
      setUser: () => noop,
      setLevel: () => noop,
      setFingerprint: () => noop,
    };
    return fn(noop);
  },

  /** Force-flush queued Catch events (e.g. before a known page unload). */
  async flushCatch(): Promise<void> {
    const c = getModuleAPI<CatchAPILike>("catch");
    if (c) await c.flush();
  },
};

export { SankofaBrowserClient };
