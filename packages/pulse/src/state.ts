/**
 * Survey state machine.
 *
 * Owned by the SurveyRenderer; the renderer mutates state through
 * the API exposed here rather than poking the answers map directly.
 * That keeps three behaviours consistent across the codebase:
 *
 *   1. Recording an answer for a question always re-runs branching
 *      to update what comes next. UI "Next" buttons + auto-advance
 *      both go through advance() so they can't drift.
 *   2. Going back rebuilds the visited stack so the back button
 *      doesn't desync after a branch.
 *   3. End-of-survey transitions resolve via the same code path as
 *      mid-survey transitions — nothing special-cases "did we just
 *      hit the last natural question".
 */

import { resolveNext } from './branching';
import {
  BRANCHING_END_OF_SURVEY,
  type AnswerState,
  type BranchingRule,
  type SurveyQuestion,
} from './types';

export interface StateSnapshot {
  /**
   * Current question being shown. Null after the survey completes
   * (the renderer should switch to the thank-you screen).
   */
  question: SurveyQuestion | null;
  /** Index in the natural question order, or -1 when complete. */
  index: number;
  /** Total natural questions (excludes statement display elements). */
  total: number;
  /** Visible-so-far questions, for progress + back-button. */
  visited: SurveyQuestion[];
  /** Accumulated answers keyed by question_id. */
  answers: AnswerState;
  /** True once the survey reached its end (natural or via end_survey). */
  done: boolean;
}

export class SurveyState {
  private byId: Map<string, SurveyQuestion>;
  private order: SurveyQuestion[];
  private rules: BranchingRule[];
  private visited: SurveyQuestion[] = [];
  private answers: AnswerState = {};
  private done = false;

  constructor(
    questions: SurveyQuestion[],
    rules: BranchingRule[],
    initialAnswers: AnswerState = {},
    resumeQuestionId?: string,
  ) {
    // Stable order_index sort + drop archived/removed questions.
    this.order = [...questions].sort(
      (a, b) => a.order_index - b.order_index,
    );
    this.byId = new Map(this.order.map((q) => [q.id, q]));
    this.rules = rules;
    this.answers = { ...initialAnswers };

    // Resume path: if the SDK loaded a partial, jump straight to
    // the question the respondent was last on. The visited stack
    // is rebuilt as a single-entry list — full step-back history
    // doesn't survive a session boundary.
    if (resumeQuestionId && this.byId.has(resumeQuestionId)) {
      const q = this.byId.get(resumeQuestionId)!;
      this.visited = [q];
    } else if (this.order.length > 0) {
      this.visited = [this.order[0]];
    }
  }

  snapshot(): StateSnapshot {
    const current = this.visited[this.visited.length - 1] ?? null;
    return {
      question: this.done ? null : current,
      index: current ? this.order.indexOf(current) : -1,
      total: this.order.length,
      visited: [...this.visited],
      answers: { ...this.answers },
      done: this.done,
    };
  }

  /**
   * Record an answer for the given question. Does NOT advance —
   * advance() runs branching and is called separately so the
   * renderer can validate the answer locally before transitioning.
   */
  recordAnswer(questionId: string, value: unknown): void {
    if (value === undefined) {
      delete this.answers[questionId];
      return;
    }
    this.answers[questionId] = value;
  }

  /**
   * Move to the next question. Walks branching rules attached to
   * the current question; on a fall-through, advances to the next
   * question by order_index. Returns the new snapshot.
   */
  advance(): StateSnapshot {
    if (this.done) return this.snapshot();
    const current = this.visited[this.visited.length - 1];
    if (!current) {
      this.done = true;
      return this.snapshot();
    }
    const outcome = resolveNext(this.rules, current.id, this.answers);
    if (outcome.next_question_id === BRANCHING_END_OF_SURVEY) {
      this.done = true;
      return this.snapshot();
    }
    let next: SurveyQuestion | null = null;
    if (outcome.next_question_id) {
      next = this.byId.get(outcome.next_question_id) ?? null;
    } else {
      // Fall through: natural next question.
      const idx = this.order.indexOf(current);
      if (idx >= 0 && idx < this.order.length - 1) {
        next = this.order[idx + 1];
      }
    }
    if (!next) {
      this.done = true;
      return this.snapshot();
    }
    this.visited.push(next);
    return this.snapshot();
  }

  /**
   * Step back one visited question. No-op when on the first
   * question or after completion. Does NOT clear the answer for
   * the question we step away from — the respondent might want to
   * preserve what they typed.
   */
  back(): StateSnapshot {
    if (this.done) {
      this.done = false;
    }
    if (this.visited.length > 1) {
      this.visited.pop();
    }
    return this.snapshot();
  }

  /** True when there's a previous question to step back to. */
  canGoBack(): boolean {
    return this.visited.length > 1 && !this.done;
  }

  /** Read-only access to the current question for renderer queries. */
  currentQuestion(): SurveyQuestion | null {
    if (this.done) return null;
    return this.visited[this.visited.length - 1] ?? null;
  }

  /** All accumulated answers, ready to ship in the submit payload. */
  allAnswers(): AnswerState {
    return { ...this.answers };
  }
}
