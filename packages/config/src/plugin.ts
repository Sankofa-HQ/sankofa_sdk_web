import type { SankofaPlugin, SankofaPluginContext } from "@sankofa/browser";
import { registerModuleAPI, unregisterModuleAPI } from "@sankofa/browser";
import { ConfigCache } from "./cache";
import type {
  ConfigChangeListener,
  ConfigHandshakeConfig,
  ItemDecision,
  SankofaConfigAPI,
} from "./types";

let singleton: ConfigClient | null = null;

export interface ConfigPluginOptions {
  /**
   * Bundled defaults — fallbacks when the handshake hasn't landed
   * and the cache is empty. Values must match their declared type
   * (a `string` default for a `json` item will silently return the
   * string until the handshake overrides it).
   */
  defaults?: Record<string, ItemDecision>;
  /**
   * Max age in ms to trust the persistent cache. Default: 7 days.
   */
  staleMaxMs?: number;
}

class ConfigClient implements SankofaConfigAPI {
  private cache: ConfigCache;
  private defaults: Record<string, ItemDecision>;
  private debug: (msg: string, ...rest: unknown[]) => void;
  private listeners = new Map<string, Set<ConfigChangeListener>>();

  constructor(
    storageKey: string,
    defaults: Record<string, ItemDecision>,
    debug: (msg: string, ...rest: unknown[]) => void,
    staleMaxMs?: number,
  ) {
    this.cache = new ConfigCache({ storageKey, staleMaxMs });
    this.defaults = defaults;
    this.debug = debug;
  }

  // ── SankofaConfigAPI ────────────────────────────────────────────

  get<V>(key: string, defaultValue: V): V {
    const decision = this.resolve(key);
    if (!decision) return defaultValue;
    return decision.value as V;
  }

  getDecision<V = unknown>(key: string): ItemDecision<V> | null {
    return this.resolve(key) as ItemDecision<V> | null;
  }

  getAllKeys(): string[] {
    const merged = new Set<string>([
      ...this.cache.getAllKeys(),
      ...Object.keys(this.defaults),
    ]);
    return [...merged];
  }

  getAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(this.defaults)) out[k] = d.value;
    for (const [k, d] of Object.entries(this.cache.getAll())) out[k] = d.value;
    return out;
  }

  onChange(key: string, listener: ConfigChangeListener): () => void {
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

  applyHandshake(raw: unknown): void {
    const cfg = raw as ConfigHandshakeConfig | undefined;
    if (!cfg || cfg.enabled === false) return;
    const { changed, removed } = this.cache.apply(cfg.values, cfg.etag || "");
    this.fireListeners(changed, removed);
  }

  getEtag(): string {
    return this.cache.getEtag();
  }

  private resolve(key: string): ItemDecision | null {
    return this.cache.get(key) ?? this.defaults[key] ?? null;
  }

  private fireListeners(changed: Set<string>, removed: Set<string>): void {
    for (const key of changed) {
      const bucket = this.listeners.get(key);
      if (!bucket) continue;
      const decision = this.cache.get(key);
      for (const listener of bucket) {
        try {
          listener(decision);
        } catch (err) {
          this.debug(`config onChange listener threw for ${key}`, err);
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
          this.debug(`config onChange listener threw for ${key}`, err);
        }
      }
    }
  }
}

/**
 * Plugin factory — pass to `Sankofa.init({ plugins: [...] })`. The
 * browser client's Traffic Cop sees `moduleName: "config"` and routes
 * the server's handshake payload here via applyHandshake().
 */
export function configPlugin(options: ConfigPluginOptions = {}): SankofaPlugin {
  return {
    name: "config",
    moduleName: "config",
    setup(context: SankofaPluginContext) {
      const prefix = context.getSnapshot().projectNamespace;
      const storageKey = `${prefix}:config`;
      const debug = (msg: string, ...rest: unknown[]) => context.debug(`[config] ${msg}`, ...rest);
      singleton = new ConfigClient(
        storageKey,
        options.defaults ?? {},
        debug,
        options.staleMaxMs,
      );

      // Cross-module registry — @sankofa/catch reads from here when
      // composing config_snapshot on every captured event.
      registerModuleAPI("config", singleton);

      return {
        applyHandshake(cfg) {
          singleton?.applyHandshake(cfg);
        },
        shutdown() {
          unregisterModuleAPI("config");
          singleton = null;
        },
      };
    },
  };
}

/** Host accessor. Returns null when the plugin isn't loaded. */
export function getConfig(): SankofaConfigAPI | null {
  return singleton;
}
