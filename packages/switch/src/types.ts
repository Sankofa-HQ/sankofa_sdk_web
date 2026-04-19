// ─── Wire format (from the server's handshake contributor) ─────────────────
//
// These types mirror exactly what server/engine/ee/switchmod/evaluator_batch.go
// emits under `modules.switch`. Keeping them colocated with the plugin
// makes drift impossible: a server field rename breaks the client build.

export type FlagReason =
  | "archived"
  | "halted"
  | "scheduled"
  | "no_rule"
  | "rollout"
  | "variant_assigned"
  | "variant_unavailable"
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
  | "dependency_unmet"
  | "override_parse_error"
  | (string & {}); // allow forward-compat for new reasons without a type error

export interface FlagDecision {
  value: boolean;
  variant?: string;
  reason: FlagReason;
  version: number;
}

export interface SwitchHandshakeConfig {
  enabled?: boolean;
  flags?: Record<string, FlagDecision>;
  etag?: string;
  reason?: string;
  error?: string;
}

// ─── Public plugin API surface ─────────────────────────────────────────────

export type FlagChangeListener = (decision: FlagDecision | null) => void;

export interface SankofaSwitchAPI {
  /**
   * Returns the boolean value for a flag. Boolean flags return their
   * evaluated value; variant flags return `true` iff the assigned
   * variant is not the flag's default variant (convenience flag —
   * callers who care about the variant key should use getVariant).
   *
   * `defaultValue` is returned when the flag is missing from the
   * remote config (typo / flag not yet shipped / handshake never
   * arrived and cache is empty).
   */
  getFlag(key: string, defaultValue?: boolean): boolean;

  /**
   * Returns the assigned variant key for a variant flag, or the
   * supplied default when the flag is missing or isn't a variant flag.
   * For boolean flags, returns the default (the variant field is
   * unused).
   */
  getVariant(key: string, defaultValue?: string): string;

  /**
   * Full decision envelope — value + variant + reason + version.
   * Use this for debugging ("why does this user see FALSE?") or for
   * SDK instrumentation that needs the reason tag.
   */
  getDecision(key: string): FlagDecision | null;

  /** All flag keys currently known to the plugin (from cache or handshake). */
  getAllKeys(): string[];

  /**
   * Subscribe to changes for a single flag. The callback fires when
   * the handshake refresh delivers a new decision for this key, OR
   * when the flag disappears (callback receives null).
   *
   * Returns an unsubscribe function.
   */
  onChange(key: string, listener: FlagChangeListener): () => void;
}
