import type { ItemDecision } from "./types";

/**
 * Config cache — same shape and behaviour as the switch cache but
 * keyed under a different localStorage slot. Duplicated deliberately
 * rather than abstracted: the two caches do diverge over time (config
 * adds version diffing; switch may add variant-specific callbacks)
 * and a premature shared base class would just leak across products.
 */
export interface CachedConfigPayload {
  values: Record<string, ItemDecision>;
  etag: string;
  savedAt: number;
}

export interface ConfigCacheOptions {
  storageKey: string;
  staleMaxMs?: number;
}

const DEFAULT_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export class ConfigCache {
  private values: Record<string, ItemDecision> = {};
  private etag = "";
  private savedAt = 0;
  private readonly storageKey: string;
  private readonly staleMaxMs: number;

  constructor(options: ConfigCacheOptions) {
    this.storageKey = options.storageKey;
    this.staleMaxMs = options.staleMaxMs ?? DEFAULT_STALE_MAX_MS;
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CachedConfigPayload;
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.savedAt && Date.now() - parsed.savedAt > this.staleMaxMs) return;
      this.values = parsed.values || {};
      this.etag = parsed.etag || "";
      this.savedAt = parsed.savedAt || 0;
    } catch {
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
      const payload: CachedConfigPayload = {
        values: this.values,
        etag: this.etag,
        savedAt: this.savedAt,
      };
      window.localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      /* storage full or private mode */
    }
  }

  apply(next: Record<string, ItemDecision> | undefined, etag: string): {
    changed: Set<string>;
    removed: Set<string>;
  } {
    const incoming = next || {};
    const changed = new Set<string>();
    const removed = new Set<string>();

    for (const key of Object.keys(this.values)) {
      if (!(key in incoming)) {
        removed.add(key);
      }
    }
    for (const [key, decision] of Object.entries(incoming)) {
      if (!decisionEquals(this.values[key], decision)) {
        changed.add(key);
      }
    }

    this.values = { ...incoming };
    this.etag = etag;
    this.savedAt = Date.now();
    this.persistToStorage();
    return { changed, removed };
  }

  get(key: string): ItemDecision | null {
    return this.values[key] ?? null;
  }

  getAllKeys(): string[] {
    return Object.keys(this.values);
  }

  getAll(): Record<string, ItemDecision> {
    return { ...this.values };
  }

  getEtag(): string {
    return this.etag;
  }
}

function decisionEquals(a: ItemDecision | undefined, b: ItemDecision): boolean {
  if (!a) return false;
  return (
    a.version === b.version &&
    a.reason === b.reason &&
    a.type === b.type &&
    valueEquals(a.value, b.value)
  );
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Cheap deep-ish check for JSON types — reference compare then
  // JSON.stringify as a fallback. Keeps change detection correct for
  // JSON-typed items without pulling in a deep-equals dep.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
