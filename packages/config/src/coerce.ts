/**
 * coerceConfigValue brings the Web Config reads to parity with the
 * Flutter / Android / iOS SDKs, which coerce a stored value to the runtime
 * type the caller asked for (via `defaultValue`) instead of handing back a
 * wrong-typed value.
 *
 * Why this exists: a dashboard item declared `bool` can arrive over JSON as
 * a number (`1`/`0`) or a string (`"true"`/`"false"`), and a value typed
 * `int` on one client may be read as a `double` on another. Statically-typed
 * SDKs coerce these; the previous Web passthrough (`return value as V`) both
 * skipped coercion AND returned the raw value on a type mismatch, so
 * `get("flag", false)` could hand back the number `1` instead of `true`.
 *
 * Rules (mirrors sankofa_sdk_flutter/lib/src/config/sankofa_config.dart and
 * sankofa_sdk_android .../remoteconfig/SankofaRemoteConfig.kt):
 *   - same runtime type            → return as-is
 *   - bool default ← number        → truthiness (value !== 0)
 *   - bool default ← string        → "true"/"1" → true, "false"/"0" → false
 *   - array / plain-object targets → exact kind only ([] ≠ {})
 *   - string / number targets      → exact typeof match (JSON int/float
 *                                     already unify under JS `number`, so no
 *                                     extra numeric coercion is needed)
 *   - anything else                → defaultValue (never a wrong-typed value)
 */
export function coerceConfigValue<V>(value: unknown, defaultValue: V): V {
  if (value === null || value === undefined) return defaultValue;

  // Boolean target — accept the cross-type encodings a server bool can
  // arrive as (JSON number 1/0, or string "true"/"false"/"1"/"0").
  if (typeof defaultValue === "boolean") {
    if (typeof value === "boolean") return value as unknown as V;
    if (typeof value === "number") return (value !== 0) as unknown as V;
    if (typeof value === "string") {
      const s = value.trim().toLowerCase();
      if (s === "true" || s === "1") return true as unknown as V;
      if (s === "false" || s === "0") return false as unknown as V;
    }
    return defaultValue;
  }

  // Array target — distinguish [] from {} (typeof both === "object").
  if (Array.isArray(defaultValue)) {
    return Array.isArray(value) ? (value as unknown as V) : defaultValue;
  }

  // Plain-object target — a non-array object.
  if (typeof defaultValue === "object") {
    return typeof value === "object" && !Array.isArray(value)
      ? (value as unknown as V)
      : defaultValue;
  }

  // string / number targets — exact typeof match.
  if (typeof value === typeof defaultValue) return value as unknown as V;

  return defaultValue;
}
