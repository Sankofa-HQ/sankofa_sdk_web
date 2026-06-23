// Wire format — mirrors server/engine/ee/configmod/evaluator_batch.go's
// `modules.config` payload.

export type ConfigType = "string" | "int" | "float" | "bool" | "json";

export type ItemReason =
  | "archived"
  | "no_rule"
  | "rule_matched"
  | "not_in_rollout"
  | "in_excluded_cohort"
  | "not_in_target_cohort"
  | "cohort_lookup_failed"
  | "country_blocked"
  | "country_not_in_allow"
  | "country_unknown"
  | "app_version_below_min"
  | "app_version_above_max"
  | "os_version_below_min"
  | "os_version_above_max"
  | "not_in_user_allow_list"
  | (string & {});

/**
 * One decision per config item. `value` is already typed per
 * `type` (string, number, boolean, or decoded JSON) — the SDK
 * doesn't need to re-parse unless it wants to verify.
 */
export interface ItemDecision<V = unknown> {
  value: V;
  type: ConfigType;
  reason: ItemReason;
  version: number;
}

export interface ConfigHandshakeConfig {
  enabled?: boolean;
  values?: Record<string, ItemDecision>;
  etag?: string;
  reason?: string;
  error?: string;
}

// ─── Public plugin API ─────────────────────────────────────────────────

export type ConfigChangeListener = (decision: ItemDecision | null) => void;

export interface SankofaConfigAPI {
  /**
   * Typed lookup. The generic carries the expected type so the caller
   * gets autocomplete on the return value. The stored value is coerced
   * to the runtime type implied by `defaultValue` — matching the
   * Flutter/Android/iOS SDKs — so a server `bool` that arrives as `1`
   * or `"true"` still reads back as `true`. A value that can't be
   * safely coerced, or a missing item, falls through to `defaultValue`
   * (never a wrong-typed value).
   */
  get<V>(key: string, defaultValue: V): V;

  /**
   * Full decision envelope including reason + version. Useful for
   * debugging and for SDKs that need to key cache invalidation off
   * the version field.
   */
  getDecision<V = unknown>(key: string): ItemDecision<V> | null;

  /** Every currently-known key (union of remote + local defaults). */
  getAllKeys(): string[];

  /**
   * Plain `{ key: value }` snapshot of the whole config surface.
   * Convenient for "replace my global settings object on handshake
   * refresh" flows.
   */
  getAll(): Record<string, unknown>;

  /**
   * Subscribe to changes for one key. The callback fires when a
   * handshake refresh delivers a new decision, OR when the key is
   * removed (callback receives null).
   */
  onChange(key: string, listener: ConfigChangeListener): () => void;

  /** The etag of the last applied handshake payload (empty until one lands). */
  getEtag(): string;
}
