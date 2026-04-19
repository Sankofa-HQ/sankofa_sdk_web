import type { FlagDecision } from "./types";

/**
 * Persists the last-known switch payload to localStorage so the SDK can
 * return cached values synchronously on the next app boot — before the
 * handshake round-trips. Stale-while-revalidate up to staleMaxMs; after
 * that, the cache is ignored and the inline default wins until a fresh
 * handshake lands.
 *
 * Storage shape (per project key, under the browser client's storage
 * prefix):
 *
 *   {
 *     "flags": { "new_checkout": { value: true, variant: "", reason: "rollout", version: 14 }, ... },
 *     "etag":  "sha256-...",
 *     "savedAt": 1700000000000
 *   }
 */
export interface CachedSwitchPayload {
  flags: Record<string, FlagDecision>;
  etag: string;
  savedAt: number;
}

export interface SwitchCacheOptions {
  /** localStorage key the payload lives under. */
  storageKey: string;
  /** Max age in ms to treat cached values as still authoritative. */
  staleMaxMs?: number;
}

const DEFAULT_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SwitchCache {
  private flags: Record<string, FlagDecision> = {};
  private etag = "";
  private savedAt = 0;
  private readonly storageKey: string;
  private readonly staleMaxMs: number;

  constructor(options: SwitchCacheOptions) {
    this.storageKey = options.storageKey;
    this.staleMaxMs = options.staleMaxMs ?? DEFAULT_STALE_MAX_MS;
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CachedSwitchPayload;
      if (!parsed || typeof parsed !== "object") return;
      // Discard cache older than staleMaxMs — better to serve inline
      // defaults than confidently return weeks-old values.
      if (parsed.savedAt && Date.now() - parsed.savedAt > this.staleMaxMs) return;
      this.flags = parsed.flags || {};
      this.etag = parsed.etag || "";
      this.savedAt = parsed.savedAt || 0;
    } catch {
      // Corrupt JSON — wipe the slot so the next save writes clean.
      try {
        window.localStorage.removeItem(this.storageKey);
      } catch {
        /* ignore */
      }
    }
  }

  private persistToStorage(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const payload: CachedSwitchPayload = {
        flags: this.flags,
        etag: this.etag,
        savedAt: this.savedAt,
      };
      window.localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Storage full / private mode — not fatal; we just won't persist
      // the update across reloads. In-memory cache continues to work.
    }
  }

  /**
   * Replace the cached flag map with a fresh handshake payload.
   * Returns the set of keys whose decision changed so the plugin can
   * fire onChange listeners exactly for keys that actually flipped.
   */
  apply(next: Record<string, FlagDecision> | undefined, etag: string): {
    changed: Set<string>;
    removed: Set<string>;
  } {
    const incoming = next || {};
    const changed = new Set<string>();
    const removed = new Set<string>();

    // Flags the caller removed from the config entirely.
    for (const key of Object.keys(this.flags)) {
      if (!(key in incoming)) {
        removed.add(key);
      }
    }

    // Flags whose decision object changed shape/value/version.
    for (const [key, decision] of Object.entries(incoming)) {
      if (!decisionEquals(this.flags[key], decision)) {
        changed.add(key);
      }
    }

    this.flags = { ...incoming };
    this.etag = etag;
    this.savedAt = Date.now();
    this.persistToStorage();
    return { changed, removed };
  }

  getFlag(key: string): FlagDecision | null {
    return this.flags[key] ?? null;
  }

  getAllKeys(): string[] {
    return Object.keys(this.flags);
  }

  getEtag(): string {
    return this.etag;
  }
}

function decisionEquals(a: FlagDecision | undefined, b: FlagDecision): boolean {
  if (!a) return false;
  return (
    a.value === b.value &&
    a.variant === b.variant &&
    a.reason === b.reason &&
    a.version === b.version
  );
}
