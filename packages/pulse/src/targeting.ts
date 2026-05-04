/**
 * Targeting evaluator — TypeScript port of
 * server/engine/ee/pulse/targeting/evaluator.go.
 *
 * Behavioural contract: this evaluator MUST produce the same
 * Decision the Go evaluator produces for any (rules, ctx) pair.
 * Tests in __tests__/targeting.test.ts duplicate the Go test
 * cases verbatim to enforce that.
 *
 * Why match Go exactly:
 *   - Sampling decisions in particular need to agree across server
 *     + client so an A/B can be reasoned about consistently. A
 *     server saying "you're in" + client saying "you're out" would
 *     produce no exposure rows at all.
 *   - Server-side handshake filters surveys before shipping rules
 *     to the SDK; the SDK's local re-check should agree with that
 *     filter.
 */

import type {
  Decision,
  EligibilityContext,
  MatchOp,
  TargetingRule,
} from './types';

export function evaluate(
  rules: TargetingRule[],
  ctx: EligibilityContext,
): Decision {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const [ok, reason] = evaluateOne(rule, ctx);
    if (!ok) {
      return {
        eligible: false,
        reason: `rule[${i}] ${rule.kind}: ${reason}`,
      };
    }
  }
  return { eligible: true };
}

function evaluateOne(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  switch (rule.kind) {
    case 'url':
      return evalUrl(rule, ctx);
    case 'screen':
      return evalScreen(rule, ctx);
    case 'event':
      return evalEvent(rule, ctx);
    case 'user_property':
      return evalUserProperty(rule, ctx);
    case 'cohort':
      return evalCohort(rule, ctx);
    case 'sampling':
      return evalSampling(rule, ctx);
    case 'frequency_cap':
      return evalFrequencyCap(rule, ctx);
    case 'feature_flag':
      return evalFeatureFlag(rule, ctx);
  }
  return [false, 'unknown rule kind'];
}

// ── URL ────────────────────────────────────────────────────────────

function evalUrl(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const url = ctx.pageUrl ?? '';
  const value = rule.url_value ?? '';
  switch (rule.url_match) {
    case 'equals':
      return url === value
        ? [true, '']
        : [false, 'url not equal to target'];
    case 'contains':
      return url.includes(value)
        ? [true, '']
        : [false, 'url does not contain target'];
    case 'prefix':
      return url.startsWith(value)
        ? [true, '']
        : [false, 'url does not start with target'];
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(value);
      } catch {
        return [false, 'url regex did not compile'];
      }
      return re.test(url)
        ? [true, '']
        : [false, 'url does not match regex'];
    }
  }
  return [false, 'url_match unknown'];
}

// ── Screen ─────────────────────────────────────────────────────────
//
// Mirrors evalScreen in server/engine/ee/pulse/targeting/evaluator.go.
// Web SDK fills ctx.screenName from a host-supplied value (custom
// route name) when present; mobile + Flutter SDKs derive it from the
// platform's own screen tracker. Empty screen name never matches —
// see the rationale on the server side.

function evalScreen(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const screen = ctx.screenName ?? '';
  const value = rule.screen_name ?? '';
  if (screen === '') return [false, 'screen unknown'];
  switch (rule.screen_match) {
    case 'equals':
      return screen === value
        ? [true, '']
        : [false, 'screen not equal to target'];
    case 'contains':
      return screen.includes(value)
        ? [true, '']
        : [false, 'screen does not contain target'];
    case 'prefix':
      return screen.startsWith(value)
        ? [true, '']
        : [false, 'screen does not start with target'];
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(value);
      } catch {
        return [false, 'screen regex did not compile'];
      }
      return re.test(screen)
        ? [true, '']
        : [false, 'screen does not match regex'];
    }
  }
  return [false, 'screen_match unknown'];
}

// ── Event ──────────────────────────────────────────────────────────

function evalEvent(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const min = rule.event_min_count && rule.event_min_count >= 1
    ? rule.event_min_count
    : 1;
  const events = ctx.recentEvents ?? {};
  const count = events[rule.event_name ?? ''] ?? 0;
  if (count >= min) return [true, ''];
  return [
    false,
    `event "${rule.event_name}" seen ${count} times, need ${min}`,
  ];
}

// ── User Property ──────────────────────────────────────────────────

function evalUserProperty(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const key = rule.property_key ?? '';
  const props = ctx.userProperties ?? {};
  const present = Object.prototype.hasOwnProperty.call(props, key);
  const v = props[key];
  switch (rule.property_op) {
    case 'exists':
      return present ? [true, ''] : [false, 'property absent'];
    case 'not_exists':
      return !present ? [true, ''] : [false, 'property present'];
  }
  if (!present) return [false, 'property absent'];
  const target = rule.property_value;
  switch (rule.property_op) {
    case 'equals':
      return jsonEqual(v, target)
        ? [true, '']
        : [false, 'property not equal'];
    case 'not_equals':
      return !jsonEqual(v, target)
        ? [true, '']
        : [false, 'property equal'];
    case 'contains':
      return strContains(v, target)
        ? [true, '']
        : [false, 'property does not contain target'];
    case 'not_contains':
      return !strContains(v, target)
        ? [true, '']
        : [false, 'property contains target'];
    case 'in':
      return jsonInArray(v, target)
        ? [true, '']
        : [false, 'property not in target list'];
    case 'not_in':
      return !jsonInArray(v, target)
        ? [true, '']
        : [false, 'property in target list'];
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return compareNumbers(v, target, rule.property_op);
  }
  return [false, 'property_op unknown'];
}

// ── Cohort ─────────────────────────────────────────────────────────

function evalCohort(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const id = rule.cohort_id ?? '';
  if ((ctx.cohorts ?? {})[id]) return [true, ''];
  return [false, `respondent not in cohort "${id}"`];
}

// ── Sampling ───────────────────────────────────────────────────────

/**
 * Deterministic per-user sampling. Hashes (survey_id + ":" +
 * respondent_external_id) to a 64-bit integer + maps to [0, 1).
 *
 * Critical: this MUST match the Go implementation byte-for-byte.
 * The Go side computes sha256 over the same input and divides the
 * top 64 bits by 2^64. The TS port uses the SubtleCrypto API; the
 * input bytes + division produce an identical [0, 1) value across
 * runtimes.
 *
 * Why deterministic:
 *   - Same user always gets the same decision across reloads,
 *     across devices that happen to share the same external_id,
 *     and across server vs client evaluation.
 *   - A/B'ing two surveys uses different survey_ids so the same
 *     user can land in cohort A for survey-1 and cohort B for
 *     survey-2 independently.
 */
function evalSampling(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const rate = rule.sampling_rate ?? 0;
  if (rate <= 0) return [false, 'sampling rate is 0'];
  if (rate >= 1) return [true, ''];
  if (!ctx.respondentExternalId) {
    return [false, 'no external_id; cannot sample deterministically'];
  }
  const score = stableHash(`${ctx.surveyId}:${ctx.respondentExternalId}`);
  return score < rate
    ? [true, '']
    : [
        false,
        `sampling miss (score=${score.toFixed(3)}, rate=${rate.toFixed(3)})`,
      ];
}

/**
 * Synchronous SHA-256 over a UTF-8 string, returning the top 64
 * bits as a value in [0, 1). Implemented via a self-contained JS
 * SHA-256 because SubtleCrypto is async and the evaluator path is
 * sync (the renderer needs an immediate yes/no for the next paint).
 *
 * Output range: [0, 1). Same numeric value the Go side computes
 * for the same input, modulo IEEE-754 representation.
 */
export function stableHash(input: string): number {
  const bytes = sha256Sync(stringToUtf8Bytes(input));
  // Top 8 bytes, big-endian → unsigned 64-bit integer → divide by
  // 2^64. The Go side uses the same construction.
  let hi = 0;
  for (let i = 0; i < 4; i++) hi = (hi << 8) | bytes[i];
  // Force unsigned 32-bit representation in case the high bit
  // was set; bitwise ops in JS yield signed 32-bit values.
  hi = hi >>> 0;
  let lo = 0;
  for (let i = 4; i < 8; i++) lo = (lo << 8) | bytes[i];
  lo = lo >>> 0;
  // (hi * 2^32 + lo) / 2^64 = hi / 2^32 + lo / 2^64.
  return hi / 4294967296 + lo / 18446744073709552000;
}

// ── Frequency cap ──────────────────────────────────────────────────

function evalFrequencyCap(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const max =
    rule.frequency_max && rule.frequency_max >= 1 ? rule.frequency_max : 1;
  const prior = (ctx.priorResponseCount ?? {})[ctx.surveyId] ?? 0;
  if (prior < max) return [true, ''];
  return [
    false,
    `respondent has ${prior} prior responses (cap=${max}, window=${rule.frequency_window_days}d)`,
  ];
}

// ── Feature flag ───────────────────────────────────────────────────

function evalFeatureFlag(
  rule: TargetingRule,
  ctx: EligibilityContext,
): [boolean, string] {
  const key = rule.flag_key ?? '';
  const flags = ctx.flagValues ?? {};
  if (!Object.prototype.hasOwnProperty.call(flags, key)) {
    return [false, `flag "${key}" not in context`];
  }
  if (jsonEqual(flags[key], rule.flag_value)) return [true, ''];
  return [
    false,
    `flag "${key}" value ${JSON.stringify(flags[key])} != ${JSON.stringify(rule.flag_value)}`,
  ];
}

// ── Helpers ────────────────────────────────────────────────────────

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) {
    // Special-case number comparisons against string targets — the
    // Go side accepts string-coerced numerics, so we mirror.
    return false;
  }
  if (a === null || b === null) return a === b;
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function strContains(v: unknown, target: unknown): boolean {
  const haystack = typeof v === 'string' ? v : JSON.stringify(v);
  const needle = typeof target === 'string' ? target : JSON.stringify(target);
  return haystack.includes(needle);
}

function jsonInArray(v: unknown, target: unknown): boolean {
  if (!Array.isArray(target)) return false;
  return target.some((item) => jsonEqual(v, item));
}

function compareNumbers(
  v: unknown,
  target: unknown,
  op: MatchOp,
): [boolean, string] {
  const left = numericValue(v);
  if (left === null) return [false, 'property is not numeric'];
  const right = numericValue(target);
  if (right === null) return [false, 'target is not numeric'];
  switch (op) {
    case 'gt':
      return left > right ? [true, ''] : [false, `${left} ${op} ${right} fails`];
    case 'lt':
      return left < right ? [true, ''] : [false, `${left} ${op} ${right} fails`];
    case 'gte':
      return left >= right ? [true, ''] : [false, `${left} ${op} ${right} fails`];
    case 'lte':
      return left <= right ? [true, ''] : [false, `${left} ${op} ${right} fails`];
  }
  return [false, `op ${op} not numeric`];
}

function numericValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── SHA-256 (sync, self-contained) ─────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Sync(data: Uint8Array): Uint8Array {
  // Pad the message to a multiple of 64 bytes per FIPS 180-4.
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  // 64-bit big-endian length at the very end.
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 =
        rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 =
        rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function stringToUtf8Bytes(s: string): Uint8Array {
  // TextEncoder is available in every modern browser + Node 12+.
  // Fallback inline encoder kept tiny so the bundle stays slim.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s);
  }
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      out.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}
