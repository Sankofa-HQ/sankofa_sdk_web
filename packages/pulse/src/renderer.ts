/**
 * Vanilla JS survey renderer. No React dependency. Renders a
 * lightweight modal positioned bottom-right by default, walks the
 * respondent through one question at a time, and submits via the
 * PulseClient on completion.
 *
 * Design choices:
 *
 *   - Modal CSS is inlined as a <style> tag scoped under a unique
 *     attribute selector ([data-sankofa-pulse-root]) so host
 *     stylesheets can't bleed in and our CSS doesn't bleed out.
 *   - One question on screen at a time. Multi-question pages add
 *     UX complexity (keyboard nav, validation timing, error
 *     placement) without much value for the NPS/CSAT majority of
 *     surveys.
 *   - Renderers per question kind. Each kind owns its DOM + change
 *     handler + answer-extraction. Adding a new kind = one new
 *     entry in the kindRenderers map.
 *   - Phase-1 kinds: short_text, long_text, rating, nps, single,
 *     multi, boolean. The remaining 8 (slider, date, statement,
 *     ranking, matrix, consent, image_choice) ship as the SDK
 *     work continues — graceful degradation: unsupported kinds
 *     auto-skip with a debug warning.
 */

import { SurveyState } from './state';
import type {
  AnswerState,
  PulseEventListener,
  PulseEventPayload,
  PulseEvent,
  Survey,
  SurveyBundle,
  SurveyQuestion,
} from './types';

export interface RendererOptions {
  bundle: SurveyBundle;
  mount?: HTMLElement;
  /**
   * Called whenever the user advances. The host wires this to
   * PulseClient.savePartial so the partial stays fresh between
   * questions.
   */
  onAnswerChange?: (state: { answers: AnswerState; currentQuestionId: string }) => void;
  /** Called when the respondent finishes. Host submits. */
  onComplete?: (state: { answers: AnswerState }) => void | Promise<void>;
  /** Called when the respondent or host dismisses without completing. */
  onDismiss?: (state: { answers: AnswerState; reason: 'user' | 'host' }) => void;
  /** Lifecycle event broadcaster. */
  emit?: (payload: PulseEventPayload) => void;
}

const STYLE_ID = 'sankofa-pulse-styles';
const ROOT_ATTR = 'data-sankofa-pulse-root';

const STYLES = `
[${ROOT_ATTR}] {
  --sankofa-pulse-bg: #ffffff;
  --sankofa-pulse-fg: #18181b;
  --sankofa-pulse-muted: #71717a;
  --sankofa-pulse-accent: #f43f5e;
  --sankofa-pulse-border: #e4e4e7;
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: min(420px, calc(100vw - 32px));
  background: var(--sankofa-pulse-bg);
  color: var(--sankofa-pulse-fg);
  border: 1px solid var(--sankofa-pulse-border);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483600;
  overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  [${ROOT_ATTR}] {
    --sankofa-pulse-bg: #0a0a0a;
    --sankofa-pulse-fg: #fafafa;
    --sankofa-pulse-muted: #a1a1aa;
    --sankofa-pulse-border: #27272a;
  }
}
[${ROOT_ATTR}] .sankofa-pulse-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--sankofa-pulse-border);
}
[${ROOT_ATTR}] .sankofa-pulse-title {
  font-size: 13px; font-weight: 600;
}
[${ROOT_ATTR}] .sankofa-pulse-progress {
  font-size: 11px; color: var(--sankofa-pulse-muted);
}
[${ROOT_ATTR}] .sankofa-pulse-close {
  background: transparent; border: 0; cursor: pointer;
  color: var(--sankofa-pulse-muted); font-size: 18px; line-height: 1;
  padding: 0 4px;
}
[${ROOT_ATTR}] .sankofa-pulse-close:hover { color: var(--sankofa-pulse-fg); }
[${ROOT_ATTR}] .sankofa-pulse-body {
  padding: 16px; max-height: 60vh; overflow-y: auto;
}
[${ROOT_ATTR}] .sankofa-pulse-prompt {
  font-size: 14px; font-weight: 500; line-height: 1.5;
}
[${ROOT_ATTR}] .sankofa-pulse-helptext {
  font-size: 12px; color: var(--sankofa-pulse-muted); margin-top: 4px;
}
[${ROOT_ATTR}] .sankofa-pulse-input,
[${ROOT_ATTR}] .sankofa-pulse-textarea {
  width: 100%; padding: 8px 10px; font-size: 14px;
  background: transparent; color: inherit;
  border: 1px solid var(--sankofa-pulse-border); border-radius: 6px;
  margin-top: 12px; box-sizing: border-box;
}
[${ROOT_ATTR}] .sankofa-pulse-textarea { min-height: 80px; resize: vertical; }
[${ROOT_ATTR}] .sankofa-pulse-input:focus,
[${ROOT_ATTR}] .sankofa-pulse-textarea:focus {
  outline: none; border-color: var(--sankofa-pulse-accent);
}
[${ROOT_ATTR}] .sankofa-pulse-scale {
  display: flex; gap: 4px; margin-top: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-scale-btn {
  flex: 1; padding: 8px 0; font-size: 13px; font-weight: 500;
  background: transparent; color: inherit;
  border: 1px solid var(--sankofa-pulse-border); border-radius: 6px;
  cursor: pointer; transition: all 80ms;
}
[${ROOT_ATTR}] .sankofa-pulse-scale-btn:hover { border-color: var(--sankofa-pulse-accent); }
[${ROOT_ATTR}] .sankofa-pulse-scale-btn[data-selected="true"] {
  background: var(--sankofa-pulse-accent); border-color: var(--sankofa-pulse-accent);
  color: #ffffff;
}
[${ROOT_ATTR}] .sankofa-pulse-options {
  display: flex; flex-direction: column; gap: 6px; margin-top: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-option-btn {
  text-align: left; padding: 8px 10px; font-size: 13px;
  background: transparent; color: inherit;
  border: 1px solid var(--sankofa-pulse-border); border-radius: 6px;
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-option-btn:hover { border-color: var(--sankofa-pulse-accent); }
[${ROOT_ATTR}] .sankofa-pulse-option-btn[data-selected="true"] {
  border-color: var(--sankofa-pulse-accent);
  background: rgba(244, 63, 94, 0.08);
}
[${ROOT_ATTR}] .sankofa-pulse-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px 14px; border-top: 1px solid var(--sankofa-pulse-border);
}
[${ROOT_ATTR}] .sankofa-pulse-back {
  background: transparent; border: 0; cursor: pointer;
  color: var(--sankofa-pulse-muted); font-size: 12px; padding: 6px 0;
}
[${ROOT_ATTR}] .sankofa-pulse-back:disabled { visibility: hidden; }
[${ROOT_ATTR}] .sankofa-pulse-next {
  padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer;
  background: var(--sankofa-pulse-fg); color: var(--sankofa-pulse-bg);
  border: 0; border-radius: 6px;
}
[${ROOT_ATTR}] .sankofa-pulse-next:disabled { opacity: 0.4; cursor: not-allowed; }
[${ROOT_ATTR}] .sankofa-pulse-error {
  font-size: 12px; color: #ef4444; margin-top: 8px;
}
[${ROOT_ATTR}] .sankofa-pulse-thanks {
  padding: 24px 16px; text-align: center;
  font-size: 14px; color: var(--sankofa-pulse-fg);
}
`;

export class SurveyRenderer {
  private state: SurveyState;
  private bundle: SurveyBundle;
  private root: HTMLElement;
  private mount: HTMLElement;
  private opts: RendererOptions;
  private currentError: string | null = null;
  private dismissed = false;

  constructor(opts: RendererOptions) {
    this.bundle = opts.bundle;
    this.opts = opts;
    this.mount = opts.mount ?? document.body;
    ensureStyles();
    this.state = new SurveyState(
      opts.bundle.questions,
      opts.bundle.branching_rules,
      opts.bundle.partial?.answers ?? {},
      opts.bundle.partial?.current_question_id,
    );
    this.root = document.createElement('div');
    this.root.setAttribute(ROOT_ATTR, '');
    this.mount.appendChild(this.root);
    this.emit('survey_shown');
    this.render();
  }

  /** Tear down the modal. Called by host code or the close button. */
  dismiss(reason: 'user' | 'host' = 'host'): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.root.remove();
    this.opts.onDismiss?.({
      answers: this.state.allAnswers(),
      reason,
    });
    this.emit('survey_dismissed', { reason });
  }

  private emit(event: PulseEvent, extras: Record<string, unknown> = {}): void {
    if (!this.opts.emit) return;
    this.opts.emit({
      event,
      survey_id: this.bundle.survey.id,
      ...extras,
    } as PulseEventPayload);
  }

  private render(): void {
    const snap = this.state.snapshot();
    if (snap.done || !snap.question) {
      this.renderThanks();
      return;
    }
    const q = snap.question;
    const answer = snap.answers[q.id];
    this.root.innerHTML = '';
    this.root.appendChild(this.renderHeader(this.bundle.survey, snap.index, snap.total));
    const body = document.createElement('div');
    body.className = 'sankofa-pulse-body';
    body.appendChild(this.renderPrompt(q));
    const inputContainer = document.createElement('div');
    body.appendChild(inputContainer);
    const valueRef: { current: unknown } = { current: answer };
    renderInput(q, valueRef, () => this.onAnswerChange(q, valueRef.current), inputContainer);
    if (this.currentError) {
      const errEl = document.createElement('div');
      errEl.className = 'sankofa-pulse-error';
      errEl.textContent = this.currentError;
      body.appendChild(errEl);
    }
    this.root.appendChild(body);
    this.root.appendChild(this.renderFooter(q, snap, valueRef));
  }

  private renderHeader(survey: Survey, idx: number, total: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'sankofa-pulse-header';
    const title = document.createElement('div');
    title.className = 'sankofa-pulse-title';
    title.textContent = survey.name;
    const progress = document.createElement('span');
    progress.className = 'sankofa-pulse-progress';
    if (idx >= 0 && total > 0) progress.textContent = ` ${idx + 1} / ${total}`;
    title.appendChild(progress);
    const close = document.createElement('button');
    close.className = 'sankofa-pulse-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss survey');
    close.addEventListener('click', () => this.dismiss('user'));
    header.appendChild(title);
    header.appendChild(close);
    return header;
  }

  private renderPrompt(q: SurveyQuestion): HTMLElement {
    const wrap = document.createElement('div');
    const prompt = document.createElement('div');
    prompt.className = 'sankofa-pulse-prompt';
    prompt.textContent = q.prompt;
    wrap.appendChild(prompt);
    if (q.helptext) {
      const help = document.createElement('div');
      help.className = 'sankofa-pulse-helptext';
      help.textContent = q.helptext;
      wrap.appendChild(help);
    }
    return wrap;
  }

  private renderFooter(
    q: SurveyQuestion,
    snap: { visited: SurveyQuestion[] },
    valueRef: { current: unknown },
  ): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'sankofa-pulse-footer';
    const back = document.createElement('button');
    back.className = 'sankofa-pulse-back';
    back.textContent = '← Back';
    back.disabled = !this.state.canGoBack();
    back.addEventListener('click', () => {
      this.currentError = null;
      this.state.back();
      this.render();
    });
    const next = document.createElement('button');
    next.className = 'sankofa-pulse-next';
    next.textContent = isLastVisible(this.state, this.bundle.questions) ? 'Submit' : 'Next →';
    next.addEventListener('click', () => this.advance(q, valueRef));
    footer.appendChild(back);
    footer.appendChild(next);
    return footer;
  }

  private renderThanks(): void {
    this.root.innerHTML = '';
    const thanks = document.createElement('div');
    thanks.className = 'sankofa-pulse-thanks';
    thanks.textContent = 'Thanks for your feedback!';
    const close = document.createElement('button');
    close.className = 'sankofa-pulse-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.dismiss('host'));
    const header = document.createElement('div');
    header.className = 'sankofa-pulse-header';
    header.appendChild(document.createElement('div'));
    header.appendChild(close);
    this.root.appendChild(header);
    this.root.appendChild(thanks);
  }

  private async advance(q: SurveyQuestion, valueRef: { current: unknown }): Promise<void> {
    this.currentError = null;
    // Required-question gate: empty answer on a required question
    // blocks advance with an inline error rather than letting the
    // submit fail with a server 400.
    if (q.required && isEmpty(valueRef.current)) {
      this.currentError = 'This question requires an answer.';
      this.render();
      return;
    }
    this.state.recordAnswer(q.id, valueRef.current);
    this.opts.onAnswerChange?.({
      answers: this.state.allAnswers(),
      currentQuestionId: q.id,
    });
    const snap = this.state.advance();
    if (snap.done) {
      try {
        await this.opts.onComplete?.({ answers: snap.answers });
        this.emit('survey_completed');
        this.render(); // shows thanks screen
      } catch (err) {
        this.currentError =
          err instanceof Error ? err.message : 'Submission failed';
        this.render();
      }
      return;
    }
    this.render();
  }

  private onAnswerChange(q: SurveyQuestion, value: unknown): void {
    this.state.recordAnswer(q.id, value);
    this.opts.onAnswerChange?.({
      answers: this.state.allAnswers(),
      currentQuestionId: q.id,
    });
  }
}

// ── Per-kind input renderers ───────────────────────────────────────

function renderInput(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const renderer = kindRenderers[q.kind] ?? renderUnsupported;
  renderer(q, valueRef, onChange, container);
}

type KindRenderer = (
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
) => void;

const kindRenderers: Partial<Record<SurveyQuestion['kind'], KindRenderer>> = {
  short_text: renderShortText,
  long_text: renderLongText,
  number: renderNumber,
  rating: renderRating,
  nps: renderNps,
  single: renderSingle,
  multi: renderMulti,
  boolean: renderBoolean,
};

function renderShortText(
  _q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sankofa-pulse-input';
  input.maxLength = 512;
  input.value = typeof valueRef.current === 'string' ? valueRef.current : '';
  input.addEventListener('input', () => {
    valueRef.current = input.value;
    onChange();
  });
  container.appendChild(input);
}

function renderLongText(
  _q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const ta = document.createElement('textarea');
  ta.className = 'sankofa-pulse-textarea';
  ta.maxLength = 8192;
  ta.value = typeof valueRef.current === 'string' ? valueRef.current : '';
  ta.addEventListener('input', () => {
    valueRef.current = ta.value;
    onChange();
  });
  container.appendChild(ta);
}

function renderNumber(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'sankofa-pulse-input';
  if (q.validation?.min != null) input.min = String(q.validation.min);
  if (q.validation?.max != null) input.max = String(q.validation.max);
  if (typeof valueRef.current === 'number') input.value = String(valueRef.current);
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    valueRef.current = raw === '' ? undefined : Number(raw);
    onChange();
  });
  container.appendChild(input);
}

function renderRating(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const min = q.validation?.min ?? 1;
  const max = q.validation?.max ?? 5;
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-scale';
  for (let n = min; n <= max; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-scale-btn';
    btn.textContent = String(n);
    btn.dataset.selected = valueRef.current === n ? 'true' : 'false';
    btn.addEventListener('click', () => {
      valueRef.current = n;
      onChange();
      // Re-paint sibling buttons to update the selected state.
      Array.from(wrap.children).forEach((c, idx) => {
        (c as HTMLElement).dataset.selected = idx + min === n ? 'true' : 'false';
      });
    });
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

function renderNps(
  _q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-scale';
  for (let n = 0; n <= 10; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-scale-btn';
    btn.textContent = String(n);
    btn.dataset.selected = valueRef.current === n ? 'true' : 'false';
    btn.addEventListener('click', () => {
      valueRef.current = n;
      onChange();
      Array.from(wrap.children).forEach((c, idx) => {
        (c as HTMLElement).dataset.selected = idx === n ? 'true' : 'false';
      });
    });
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

function renderSingle(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-options';
  (q.options ?? []).forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-option-btn';
    btn.textContent = opt.label;
    btn.dataset.selected = valueRef.current === opt.key ? 'true' : 'false';
    btn.addEventListener('click', () => {
      valueRef.current = opt.key;
      onChange();
      Array.from(wrap.children).forEach((c) => {
        const el = c as HTMLElement;
        el.dataset.selected = el === btn ? 'true' : 'false';
      });
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderMulti(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-options';
  const initial: string[] = Array.isArray(valueRef.current)
    ? (valueRef.current as string[])
    : [];
  const selected = new Set(initial);
  valueRef.current = [...selected];
  (q.options ?? []).forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-option-btn';
    btn.textContent = opt.label;
    btn.dataset.selected = selected.has(opt.key) ? 'true' : 'false';
    btn.addEventListener('click', () => {
      if (selected.has(opt.key)) selected.delete(opt.key);
      else selected.add(opt.key);
      btn.dataset.selected = selected.has(opt.key) ? 'true' : 'false';
      valueRef.current = [...selected];
      onChange();
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderBoolean(
  _q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-options';
  const labels: Array<[string, boolean]> = [['Yes', true], ['No', false]];
  labels.forEach(([label, val]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-option-btn';
    btn.textContent = label;
    btn.dataset.selected = valueRef.current === val ? 'true' : 'false';
    btn.addEventListener('click', () => {
      valueRef.current = val;
      onChange();
      Array.from(wrap.children).forEach((c) => {
        const el = c as HTMLElement;
        el.dataset.selected = el === btn ? 'true' : 'false';
      });
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderUnsupported(
  q: SurveyQuestion,
  _valueRef: { current: unknown },
  _onChange: () => void,
  container: HTMLElement,
): void {
  // Phase 1 ships 7 of 15 kinds in the renderer; the rest land
  // alongside their composer affordances. Unsupported = visible
  // placeholder so the operator notices instead of silent skip.
  const note = document.createElement('div');
  note.className = 'sankofa-pulse-helptext';
  note.textContent = `[Unsupported question kind: ${q.kind}]`;
  container.appendChild(note);
}

// ── Helpers ────────────────────────────────────────────────────────

function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function isLastVisible(
  state: SurveyState,
  questions: SurveyQuestion[],
): boolean {
  // Heuristic for the Submit-button label: shows "Submit" when the
  // current question is the last one in natural order. Branching
  // can still surface more questions after — the final advance()
  // resolves them. Worst case the label says "Submit" then the
  // user sees one more question; minor UX surprise vs the
  // alternative of always saying "Next".
  const current = state.currentQuestion();
  if (!current) return false;
  const sorted = [...questions].sort((a, b) => a.order_index - b.order_index);
  return sorted[sorted.length - 1]?.id === current.id;
}

export type { PulseEventListener };
