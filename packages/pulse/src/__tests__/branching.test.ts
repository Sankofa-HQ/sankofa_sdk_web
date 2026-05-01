/**
 * Branching evaluator tests. Mirror the Go suite at
 * server/engine/ee/pulse/branching/evaluator_test.go for cross-
 * language behavioural equivalence.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resolveNext, evaluateCondition } from '../branching';
import { BRANCHING_END_OF_SURVEY, type BranchingRule } from '../types';

test('empty rules → fall through', () => {
  const out = resolveNext([], 'psq_q1', {});
  assert.equal(out.next_question_id, '');
});

test('no matching rule → fall through', () => {
  const rules: BranchingRule[] = [
    {
      from_question_id: 'psq_q1',
      condition: {
        kind: 'answer',
        question_id: 'psq_q1',
        op: 'equals',
        value: 'never',
      },
      action: 'skip_to',
      to_question_id: 'psq_q5',
    },
  ];
  const out = resolveNext(rules, 'psq_q1', { psq_q1: 'always' });
  assert.equal(out.next_question_id, '');
});

test('skip_to fires on match', () => {
  const rules: BranchingRule[] = [
    {
      from_question_id: 'psq_nps',
      condition: {
        kind: 'answer',
        question_id: 'psq_nps',
        op: 'lt',
        value: 7,
      },
      action: 'skip_to',
      to_question_id: 'psq_why',
    },
  ];
  const out = resolveNext(rules, 'psq_nps', { psq_nps: 3 });
  assert.equal(out.next_question_id, 'psq_why');
});

test('end_survey fires on match', () => {
  const rules: BranchingRule[] = [
    {
      from_question_id: 'psq_consent',
      condition: {
        kind: 'answer',
        question_id: 'psq_consent',
        op: 'not_answered',
      },
      action: 'end_survey',
    },
  ];
  const out = resolveNext(rules, 'psq_consent', {});
  assert.equal(out.next_question_id, BRANCHING_END_OF_SURVEY);
});

test('first matching rule wins', () => {
  const rules: BranchingRule[] = [
    {
      from_question_id: 'psq_q1',
      condition: { kind: 'answer', question_id: 'psq_q1', op: 'answered' },
      action: 'skip_to',
      to_question_id: 'psq_a',
    },
    {
      from_question_id: 'psq_q1',
      condition: {
        kind: 'answer',
        question_id: 'psq_q1',
        op: 'equals',
        value: 'x',
      },
      action: 'skip_to',
      to_question_id: 'psq_b',
    },
  ];
  const out = resolveNext(rules, 'psq_q1', { psq_q1: 'x' });
  assert.equal(out.next_question_id, 'psq_a');
});

test('rules for other from-questions are ignored', () => {
  const rules: BranchingRule[] = [
    {
      from_question_id: 'psq_q2',
      condition: { kind: 'answer', question_id: 'psq_q2', op: 'answered' },
      action: 'skip_to',
      to_question_id: 'psq_z',
    },
  ];
  const out = resolveNext(rules, 'psq_q1', { psq_q2: 'x' });
  assert.equal(out.next_question_id, '');
});

test('numeric comparators (incl. string-coerced)', () => {
  const cases: Array<{
    op: 'lt' | 'lte' | 'gt' | 'gte';
    val: number;
    answer: unknown;
    want: boolean;
  }> = [
    { op: 'lt', val: 7, answer: 3, want: true },
    { op: 'lt', val: 7, answer: 7, want: false },
    { op: 'lte', val: 7, answer: 7, want: true },
    { op: 'gt', val: 7, answer: 8, want: true },
    { op: 'gte', val: 7, answer: 7, want: true },
    { op: 'gt', val: 7, answer: '10', want: true },
    { op: 'gt', val: 7, answer: 'abc', want: false },
  ];
  for (const c of cases) {
    const ok = evaluateCondition(
      { kind: 'answer', question_id: 'q', op: c.op, value: c.val },
      { q: c.answer },
    );
    assert.equal(ok, c.want, `op=${c.op} val=${c.val} answer=${JSON.stringify(c.answer)}`);
  }
});

test('contains works for arrays + strings', () => {
  const arrCond = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'contains' as const,
    value: 'key_b',
  };
  assert.equal(
    evaluateCondition(arrCond, { q: ['key_a', 'key_b', 'key_c'] }),
    true,
  );
  assert.equal(evaluateCondition(arrCond, { q: ['key_a', 'key_c'] }), false);

  const strCond = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'contains' as const,
    value: 'slow',
  };
  assert.equal(
    evaluateCondition(strCond, { q: 'the app feels slow' }),
    true,
  );
  assert.equal(
    evaluateCondition(strCond, { q: 'the app feels fast' }),
    false,
  );
});

test('in matches array values', () => {
  const cond = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'in' as const,
    value: ['pro', 'enterprise'],
  };
  assert.equal(evaluateCondition(cond, { q: 'pro' }), true);
  assert.equal(evaluateCondition(cond, { q: 'free' }), false);
});

test('answered + not_answered handle empty / missing', () => {
  const answered = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'answered' as const,
  };
  const notAnswered = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'not_answered' as const,
  };

  assert.equal(evaluateCondition(answered, { q: 'x' }), true);
  assert.equal(evaluateCondition(notAnswered, { q: 'x' }), false);

  assert.equal(evaluateCondition(answered, { q: '' }), false);
  assert.equal(evaluateCondition(notAnswered, { q: '' }), true);

  assert.equal(evaluateCondition(answered, { q: [] }), false);

  assert.equal(evaluateCondition(answered, {}), false);
  assert.equal(evaluateCondition(notAnswered, {}), true);
});

test('value-needing ops fail closed when answer is missing', () => {
  const cond = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'equals' as const,
    value: 'x',
  };
  assert.equal(evaluateCondition(cond, {}), false);
});

test('boolean answers coerce to numeric', () => {
  const cond = {
    kind: 'answer' as const,
    question_id: 'q',
    op: 'gt' as const,
    value: 0,
  };
  assert.equal(evaluateCondition(cond, { q: true }), true);
  assert.equal(evaluateCondition(cond, { q: false }), false);
});
