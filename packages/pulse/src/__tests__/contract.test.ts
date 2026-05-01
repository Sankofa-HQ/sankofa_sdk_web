/**
 * Cross-SDK contract test. Reads the canonical golden submit body
 * from `sdks/_contract_tests/goldens/pulse_submit_basic.json` and
 * asserts that the Web SDK's `SubmitPayload` shape serialises the
 * same fixture inputs into a structurally identical JSON payload.
 *
 * If this test fails, the Web wire shape has drifted away from the
 * server contract. Fix the SDK, not the golden — the golden mirrors
 * what the server's `ingestPayload` struct accepts in
 * `server/engine/ee/pulse/handlers_ingest.go`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import type { SubmitPayload } from '../types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('pulse_submit_basic matches golden', () => {
  const golden = readGolden('pulse_submit_basic.json');
  const payload: SubmitPayload = {
    survey_id: 'psv_test_001',
    respondent: {
      user_id: 'usr_42',
      external_id: 'ext_42',
      email: 'alice@example.com',
    },
    context: {
      session_id: 'sess_abc',
      anonymous_id: 'anon_xyz',
      platform: 'contract-test',
      os_version: 'test-os',
      app_version: '1.0.0',
      locale: 'en-US',
    },
    answers: {
      q1: 'hello',
      q2: 9,
      q3: ['red', 'green'],
    },
  };

  const produced = JSON.parse(JSON.stringify(payload));
  assertStructurallyEqual(golden, produced, '$');
});

function readGolden(name: string): unknown {
  const file = resolveGolden(name);
  assert.ok(file, `golden file ${name} not found`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Walks up from this test file's directory until it finds
 * `sdks/_contract_tests/goldens/<name>`. Falls back to
 * `SANKOFA_CONTRACT_GOLDENS` for CI runs that exec outside the
 * workspace.
 */
function resolveGolden(name: string): string | null {
  const override = process.env.SANKOFA_CONTRACT_GOLDENS;
  if (override) {
    const f = path.join(override, name);
    if (fs.existsSync(f)) return f;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(
      dir,
      'sdks',
      '_contract_tests',
      'goldens',
      name,
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Structural equality: same keys, same values, same nesting.
 * Numbers compare by `Number(...)` so `9` and `9.0` aren't a
 * false positive across language serialisers.
 */
function assertStructurallyEqual(
  expected: unknown,
  actual: unknown,
  pathStr: string,
): void {
  if (expected === null || expected === undefined) {
    assert.equal(actual, expected, pathStr);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${pathStr}: expected array`);
    assert.equal(
      (actual as unknown[]).length,
      expected.length,
      `${pathStr}: list length`,
    );
    for (let i = 0; i < expected.length; i++) {
      assertStructurallyEqual(
        expected[i],
        (actual as unknown[])[i],
        `${pathStr}[${i}]`,
      );
    }
    return;
  }
  if (typeof expected === 'object') {
    assert.ok(
      typeof actual === 'object' && actual !== null && !Array.isArray(actual),
      `${pathStr}: expected object`,
    );
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    assert.deepEqual(
      actualKeys,
      expectedKeys,
      `${pathStr}: key set mismatch`,
    );
    for (const key of expectedKeys) {
      assertStructurallyEqual(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        `${pathStr}.${key}`,
      );
    }
    return;
  }
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${pathStr}: expected number`);
    assert.ok(
      Math.abs((actual as number) - expected) < 1e-9,
      `${pathStr}: ${expected} != ${actual}`,
    );
    return;
  }
  assert.equal(actual, expected, pathStr);
}
