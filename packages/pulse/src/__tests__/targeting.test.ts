/**
 * Targeting evaluator tests. Mirror the Go test suite at
 * server/engine/ee/pulse/targeting/evaluator_test.go to enforce
 * cross-language behavioural equivalence — failures here mean the
 * server + SDK would disagree about whether a respondent is
 * eligible, which is exactly the divergence the shared DSL is
 * designed to prevent.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { evaluate, stableHash } from '../targeting';
import type { EligibilityContext, TargetingRule } from '../types';

function ctx(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    surveyId: 'psv_x',
    respondentExternalId: 'user_42',
    pageUrl: 'https://x.com/checkout',
    userProperties: {},
    cohorts: {},
    flagValues: {},
    recentEvents: {},
    priorResponseCount: {},
    ...overrides,
  };
}

test('empty rules → eligible', () => {
  const d = evaluate([], ctx());
  assert.equal(d.eligible, true);
});

test('AND-of-rules: all must match', () => {
  const rules: TargetingRule[] = [
    { kind: 'url', url_match: 'contains', url_value: '/checkout' },
    {
      kind: 'user_property',
      property_key: 'plan',
      property_op: 'equals',
      property_value: 'pro',
    },
  ];
  const proCtx = ctx({ userProperties: { plan: 'pro' } });
  assert.equal(evaluate(rules, proCtx).eligible, true);
  const freeCtx = ctx({ userProperties: { plan: 'free' } });
  assert.equal(evaluate(rules, freeCtx).eligible, false);
});

test('url match operations', () => {
  const cases: Array<{
    match: 'equals' | 'contains' | 'prefix' | 'regex';
    value: string;
    url: string;
    want: boolean;
  }> = [
    { match: 'equals', value: 'https://x.com/', url: 'https://x.com/', want: true },
    { match: 'equals', value: 'https://x.com/', url: 'https://x.com/checkout', want: false },
    { match: 'contains', value: '/checkout', url: 'https://x.com/app/checkout/v2', want: true },
    { match: 'contains', value: '/checkout', url: 'https://x.com/app/cart', want: false },
    { match: 'prefix', value: 'https://x.com/', url: 'https://x.com/checkout', want: true },
    { match: 'prefix', value: 'https://x.com/', url: 'https://other.com/x', want: false },
    { match: 'regex', value: '\\.com/(\\w+)/checkout', url: 'https://x.com/app/checkout', want: true },
    { match: 'regex', value: '\\.com/(\\w+)/checkout', url: 'https://x.com/checkout', want: false },
  ];
  for (const c of cases) {
    const d = evaluate(
      [{ kind: 'url', url_match: c.match, url_value: c.value }],
      ctx({ pageUrl: c.url }),
    );
    assert.equal(
      d.eligible,
      c.want,
      `url ${c.match} ${c.value} ${c.url} → ${d.eligible} want ${c.want}`,
    );
  }
});

test('event respects min count', () => {
  for (const [count, want] of [
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [10, true],
  ] as Array<[number, boolean]>) {
    const d = evaluate(
      [{ kind: 'event', event_name: 'purchased', event_min_count: 3 }],
      ctx({ recentEvents: { purchased: count } }),
    );
    assert.equal(d.eligible, want, `count=${count} → ${d.eligible}`);
  }
});

test('event default min count = 1', () => {
  const rule: TargetingRule = { kind: 'event', event_name: 'signup' };
  assert.equal(
    evaluate([rule], ctx({ recentEvents: { signup: 1 } })).eligible,
    true,
  );
  assert.equal(
    evaluate([rule], ctx({ recentEvents: { signup: 0 } })).eligible,
    false,
  );
});

test('user_property equals + numeric ops + in', () => {
  const equals = (v: unknown): TargetingRule => ({
    kind: 'user_property',
    property_key: 'k',
    property_op: 'equals',
    property_value: v,
  });
  assert.equal(
    evaluate([equals('pro')], ctx({ userProperties: { k: 'pro' } })).eligible,
    true,
  );
  assert.equal(
    evaluate([equals('pro')], ctx({ userProperties: { k: 'free' } })).eligible,
    false,
  );

  const numericCases: Array<{
    op: 'gt' | 'lt' | 'gte' | 'lte';
    val: number;
    actual: unknown;
    want: boolean;
  }> = [
    { op: 'gt', val: 5, actual: 10, want: true },
    { op: 'gt', val: 5, actual: 5, want: false },
    { op: 'gte', val: 5, actual: 5, want: true },
    { op: 'lt', val: 100, actual: 99, want: true },
    { op: 'lte', val: 100, actual: 100, want: true },
    { op: 'gt', val: 5, actual: '10', want: true },
    { op: 'gt', val: 5, actual: 'abc', want: false },
  ];
  for (const c of numericCases) {
    const rule: TargetingRule = {
      kind: 'user_property',
      property_key: 'k',
      property_op: c.op,
      property_value: c.val,
    };
    const d = evaluate([rule], ctx({ userProperties: { k: c.actual } }));
    assert.equal(
      d.eligible,
      c.want,
      `op=${c.op} val=${c.val} actual=${JSON.stringify(c.actual)}`,
    );
  }

  const inRule: TargetingRule = {
    kind: 'user_property',
    property_key: 'plan',
    property_op: 'in',
    property_value: ['pro', 'enterprise'],
  };
  for (const [val, want] of [
    ['pro', true],
    ['enterprise', true],
    ['free', false],
    ['trial', false],
  ] as Array<[string, boolean]>) {
    assert.equal(
      evaluate([inRule], ctx({ userProperties: { plan: val } })).eligible,
      want,
      `in: val=${val}`,
    );
  }
});

test('user_property exists / not_exists', () => {
  const exists: TargetingRule = {
    kind: 'user_property',
    property_key: 'k',
    property_op: 'exists',
  };
  const notExists: TargetingRule = {
    kind: 'user_property',
    property_key: 'k',
    property_op: 'not_exists',
  };
  const present = ctx({ userProperties: { k: 'v' } });
  const absent = ctx({ userProperties: { other: 'v' } });
  assert.equal(evaluate([exists], present).eligible, true);
  assert.equal(evaluate([exists], absent).eligible, false);
  assert.equal(evaluate([notExists], present).eligible, false);
  assert.equal(evaluate([notExists], absent).eligible, true);
});

test('sampling is deterministic for same user', () => {
  const rule: TargetingRule = { kind: 'sampling', sampling_rate: 0.5 };
  const c = ctx();
  const first = evaluate([rule], c).eligible;
  for (let i = 0; i < 100; i++) {
    assert.equal(
      evaluate([rule], c).eligible,
      first,
      `sampling drifted on iteration ${i}`,
    );
  }
});

test('sampling distributes near target rate ±5%', () => {
  const rule: TargetingRule = { kind: 'sampling', sampling_rate: 0.5 };
  let admitted = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const c = ctx({ respondentExternalId: `user_${i}` });
    if (evaluate([rule], c).eligible) admitted++;
  }
  const rate = admitted / N;
  assert.ok(rate >= 0.45 && rate <= 0.55, `rate=${rate} drift outside ±5%`);
});

test('sampling rate 0 never admits', () => {
  const rule: TargetingRule = { kind: 'sampling', sampling_rate: 0 };
  for (let i = 0; i < 100; i++) {
    assert.equal(
      evaluate([rule], ctx({ respondentExternalId: `u${i}` })).eligible,
      false,
    );
  }
});

test('sampling rate 1 always admits', () => {
  const rule: TargetingRule = { kind: 'sampling', sampling_rate: 1 };
  for (let i = 0; i < 100; i++) {
    assert.equal(
      evaluate([rule], ctx({ respondentExternalId: `u${i}` })).eligible,
      true,
    );
  }
});

test('sampling: anonymous respondent fails closed', () => {
  const rule: TargetingRule = { kind: 'sampling', sampling_rate: 0.5 };
  assert.equal(
    evaluate([rule], ctx({ respondentExternalId: '' })).eligible,
    false,
  );
});

test('frequency cap enforces prior count', () => {
  const rule: TargetingRule = {
    kind: 'frequency_cap',
    frequency_scope: 'per_user',
    frequency_max: 2,
    frequency_window_days: 30,
  };
  for (const [count, want] of [
    [0, true],
    [1, true],
    [2, false],
  ] as Array<[number, boolean]>) {
    const c = ctx({ priorResponseCount: { psv_x: count } });
    assert.equal(evaluate([rule], c).eligible, want, `prior=${count}`);
  }
});

test('feature_flag matches when value equal', () => {
  const rule: TargetingRule = {
    kind: 'feature_flag',
    flag_key: 'show_survey',
    flag_value: true,
  };
  assert.equal(
    evaluate([rule], ctx({ flagValues: { show_survey: true } })).eligible,
    true,
  );
  assert.equal(
    evaluate([rule], ctx({ flagValues: { show_survey: false } })).eligible,
    false,
  );
  assert.equal(evaluate([rule], ctx({ flagValues: {} })).eligible, false);
});

test('stableHash produces a value in [0, 1)', () => {
  for (let i = 0; i < 100; i++) {
    const score = stableHash(`survey:${i}`);
    assert.ok(score >= 0 && score < 1, `score=${score} out of range`);
  }
});

test('stableHash is deterministic', () => {
  const a = stableHash('psv_x:user_42');
  const b = stableHash('psv_x:user_42');
  assert.equal(a, b);
  const c = stableHash('psv_x:user_43');
  assert.notEqual(a, c);
});
