/**
 * coerceConfigValue — Config read parity tests.
 *
 * Pins the cross-type coercion that brings Web's Config reads in line with
 * the Flutter / Android / iOS SDKs: a server `bool` that arrives over JSON
 * as a number (1/0) or string ("true"/"false") must still read back as a
 * boolean, and an incompatible value must fall through to the caller's
 * default rather than being handed back wrong-typed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { coerceConfigValue } from "../coerce";

test("same-type values pass through untouched", () => {
  assert.equal(coerceConfigValue("hi", "default"), "hi");
  assert.equal(coerceConfigValue(42, 0), 42);
  assert.equal(coerceConfigValue(3.14, 0), 3.14);
  assert.equal(coerceConfigValue(true, false), true);
  assert.deepEqual(coerceConfigValue({ a: 1 }, {}), { a: 1 });
  assert.deepEqual(coerceConfigValue([1, 2], []), [1, 2]);
});

test("bool default coerces number encodings", () => {
  assert.equal(coerceConfigValue(1, false), true);
  assert.equal(coerceConfigValue(0, true), false);
  assert.equal(coerceConfigValue(2, false), true); // any non-zero is truthy
});

test("bool default coerces string encodings", () => {
  assert.equal(coerceConfigValue("true", false), true);
  assert.equal(coerceConfigValue("TRUE", false), true);
  assert.equal(coerceConfigValue("1", false), true);
  assert.equal(coerceConfigValue("false", true), false);
  assert.equal(coerceConfigValue("0", true), false);
  assert.equal(coerceConfigValue(" True ", false), true); // trimmed
});

test("bool default rejects un-coercible strings → default", () => {
  assert.equal(coerceConfigValue("maybe", false), false);
  assert.equal(coerceConfigValue("yes", true), true);
});

test("null / undefined value → default", () => {
  assert.equal(coerceConfigValue(null, "fallback"), "fallback");
  assert.equal(coerceConfigValue(undefined, 7), 7);
});

test("incompatible types fall through to default (no wrong-typed return)", () => {
  assert.equal(coerceConfigValue("hello", 0), 0); // string → number default
  assert.equal(coerceConfigValue(42, "x"), "x"); // number → string default
  assert.equal(coerceConfigValue("42", 0), 0); // numeric string NOT coerced (matches Flutter/Android)
  assert.equal(coerceConfigValue(true, 0), 0); // bool → number default
});

test("array vs plain-object are kept distinct", () => {
  assert.deepEqual(coerceConfigValue({ a: 1 }, []), []); // object → array default
  assert.deepEqual(coerceConfigValue([1], {}), {}); // array → object default
});
