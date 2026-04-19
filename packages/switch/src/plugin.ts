import type { SankofaPlugin, SankofaPluginContext } from "@sankofa/browser";
import { SwitchCache } from "./cache";
import type {
  FlagChangeListener,
  FlagDecision,
  SankofaSwitchAPI,
  SwitchHandshakeConfig,
} from "./types";

/**
 * Module-level singleton API handle. `switchPlugin()` wires the handle
 * into the plugin manager; callers read it via `getSwitch()`. Using a
 * module singleton (rather than exposing the plugin instance) lets
 * `sankofa.switch.getFlag(...)` work without threading the client
 * through every call site.
 */
let singleton: SwitchClient | null = null;

export interface SwitchPluginOptions {
  /**
   * Bundled defaults — loaded synchronously at init so getFlag() has
   * something to return if the handshake never completes. Wire format
   * matches the server's FlagDecision, not the raw boolean, so the
   * caller can precompute reasons for debugging.
   */
  defaults?: Record<string, FlagDecision>;
  /**
   * Max age in ms to treat cached values as still authoritative.
   * Default: 7 days (stale-while-revalidate).
   */
  staleMaxMs?: number;
}

class SwitchClient implements SankofaSwitchAPI {
  private cache: SwitchCache;
  private defaults: Record<string, FlagDecision>;
  private debug: (msg: string, ...rest: unknown[]) => void;
  private listeners = new Map<string, Set<FlagChangeListener>>();

  constructor(
    storageKey: string,
    defaults: Record<string, FlagDecision>,
    debug: (msg: string, ...rest: unknown[]) => void,
    staleMaxMs?: number,
  ) {
    this.cache = new SwitchCache({ storageKey, staleMaxMs });
    this.defaults = defaults;
    this.debug = debug;
  }

  // ── SankofaSwitchAPI ────────────────────────────────────────────

  getFlag(key: string, defaultValue = false): boolean {
    const decision = this.resolve(key);
    if (!decision) return defaultValue;
    return decision.value;
  }

  getVariant(key: string, defaultValue = ""): string {
    const decision = this.resolve(key);
    if (!decision) return defaultValue;
    return decision.variant ?? defaultValue;
  }

  getDecision(key: string): FlagDecision | null {
    return this.resolve(key);
  }

  getAllKeys(): string[] {
    const merged = new Set<string>([
      ...this.cache.getAllKeys(),
      ...Object.keys(this.defaults),
    ]);
    return [...merged];
  }

  onChange(key: string, listener: FlagChangeListener): () => void {
    let bucket = this.listeners.get(key);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(key, bucket);
    }
    bucket.add(listener);
    return () => {
      const b = this.listeners.get(key);
      if (!b) return;
      b.delete(listener);
      if (b.size === 0) this.listeners.delete(key);
    };
  }

  // ── Plugin callbacks ─────────────────────────────────────────────

  /** Called by the Traffic Cop when the handshake delivers a switch config. */
  applyHandshake(raw: unknown): void {
    const cfg = raw as SwitchHandshakeConfig | undefined;
    if (!cfg || cfg.enabled === false) {
      // Module disabled server-side — keep cached decisions so SDK
      // calls still return something sensible, but don't fire spurious
      // onChange listeners.
      return;
    }
    const { changed, removed } = this.cache.apply(cfg.flags, cfg.etag || "");
    this.fireListeners(changed, removed);
  }

  getEtag(): string {
    return this.cache.getEtag();
  }

  private resolve(key: string): FlagDecision | null {
    const fromCache = this.cache.getFlag(key);
    if (fromCache) return fromCache;
    return this.defaults[key] ?? null;
  }

  private fireListeners(changed: Set<string>, removed: Set<string>): void {
    for (const key of changed) {
      const bucket = this.listeners.get(key);
      if (!bucket) continue;
      const decision = this.cache.getFlag(key);
      for (const listener of bucket) {
        try {
          listener(decision);
        } catch (err) {
          this.debug(`switch onChange listener threw for ${key}`, err);
        }
      }
    }
    for (const key of removed) {
      const bucket = this.listeners.get(key);
      if (!bucket) continue;
      for (const listener of bucket) {
        try {
          listener(null);
        } catch (err) {
          this.debug(`switch onChange listener threw for ${key}`, err);
        }
      }
    }
  }
}

/**
 * The factory every app passes to `Sankofa.init({ plugins: [...] })`.
 * Returns a SankofaPlugin whose `moduleName` is "switch" so the
 * browser client's Traffic Cop routes the server's handshake payload
 * to applyHandshake().
 *
 * Idempotent: calling the factory twice in the same process keeps
 * the first instance to avoid dangling listeners. Next init() will
 * replace it (client calls shutdown() first).
 */
export function switchPlugin(options: SwitchPluginOptions = {}): SankofaPlugin {
  return {
    name: "switch",
    moduleName: "switch",
    setup(context: SankofaPluginContext) {
      // The client sets projectNamespace to the per-project storage
      // prefix — reusing it here keeps every plugin's storage slot
      // under the same tenant root.
      const prefix = context.getSnapshot().projectNamespace;
      const storageKey = `${prefix}:switch`;
      const debug = (msg: string, ...rest: unknown[]) => context.debug(`[switch] ${msg}`, ...rest);
      singleton = new SwitchClient(
        storageKey,
        options.defaults ?? {},
        debug,
        options.staleMaxMs,
      );
      return {
        applyHandshake(cfg) {
          singleton?.applyHandshake(cfg);
        },
        shutdown() {
          singleton = null;
        },
      };
    },
  };
}

/**
 * Host-side accessor. Call after Sankofa.init() resolves. Returns null
 * when the plugin isn't loaded (missing from init plugins[]) so callers
 * can handle the "forgot to include switchPlugin" case gracefully.
 */
export function getSwitch(): SankofaSwitchAPI | null {
  return singleton;
}
