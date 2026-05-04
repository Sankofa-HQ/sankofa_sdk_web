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

import { BRAND_ICON_DATA_URL } from './brand';
import { buildTranslator, type Translator } from './i18n';
import { SurveyState } from './state';
import type {
  AnswerState,
  PulseEventListener,
  PulseEventPayload,
  PulseEvent,
  Survey,
  SurveyBundle,
  SurveyQuestion,
  SurveyTheme,
} from './types';

export interface RendererOptions {
  bundle: SurveyBundle;
  mount?: HTMLElement;
  /**
   * Inline mode renders the survey as a static centered card
   * filling its mount container, instead of the default
   * bottom-right corner modal. Used by the hosted page (/s/:slug)
   * + by host apps that want to embed the survey inside a layout
   * column rather than overlaying it.
   */
  inline?: boolean;
  /**
   * BCP-47 locale to render. When matching translation keys exist
   * on the bundle, source strings are replaced. Falls back to
   * source on miss; falls back further to navigator.language.
   */
  locale?: string;
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
/* Defensive isolation against host page CSS bleed.
   Real customer apps routinely have global rules like
   'button { box-shadow, transform, transition, font-weight }',
   plus 'button:hover:not(:disabled) { ... }' which has 0,2,1
   specificity and would beat a plain '[root] button' reset
   (0,1,1). Reverting all CSS resets the base; !important on the
   bleed-prone properties beats higher-specificity host rules
   regardless of state (:hover, :focus, :active) without nuking
   the SDK class rules below — those keep applying normally. */
[${ROOT_ATTR}] button,
[${ROOT_ATTR}] input,
[${ROOT_ATTR}] textarea,
[${ROOT_ATTR}] select,
[${ROOT_ATTR}] a {
  all: revert;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  letter-spacing: normal;
  text-transform: none;
  box-shadow: none !important;
  transform: none !important;
}
[${ROOT_ATTR}] {
  --sankofa-pulse-bg: #ffffff;
  --sankofa-pulse-fg: #18181b;
  --sankofa-pulse-muted: #71717a;
  --sankofa-pulse-accent: #f43f5e;
  --sankofa-pulse-border: #e4e4e7;
  /* Default position is bottom-right. Position-specific selectors
     below override the offsets — keep these as the fallback so a
     theme without an explicit position still renders the way the
     SDK has historically shipped. */
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
/* Position presets — applied via the data-sankofa-pulse-position
   attribute set by applyTheme(). All four corners use a 24px gutter;
   center docks the card horizontally + vertically with translate(). */
[${ROOT_ATTR}][data-sankofa-pulse-position="bottom-right"] {
  bottom: 24px; right: 24px; top: auto; left: auto;
  transform: none;
}
[${ROOT_ATTR}][data-sankofa-pulse-position="bottom-left"] {
  bottom: 24px; left: 24px; top: auto; right: auto;
  transform: none;
}
[${ROOT_ATTR}][data-sankofa-pulse-position="top-right"] {
  top: 24px; right: 24px; bottom: auto; left: auto;
  transform: none;
}
[${ROOT_ATTR}][data-sankofa-pulse-position="top-left"] {
  top: 24px; left: 24px; bottom: auto; right: auto;
  transform: none;
}
[${ROOT_ATTR}][data-sankofa-pulse-position="center"] {
  top: 50%; left: 50%; bottom: auto; right: auto;
  transform: translate(-50%, -50%);
}
/* Phone-width fallback: corner positioning is unusable on a
   320–414 wide viewport, so we collapse to a full-width bottom
   sheet regardless of the chosen position. The center value keeps
   its top-50% / translate(-50%) behaviour because it already reads
   as a centred sheet on small screens. */
@media (max-width: 480px) {
  [${ROOT_ATTR}]:not([data-sankofa-pulse-inline="true"]):not([data-sankofa-pulse-position="center"]) {
    bottom: 0; right: 0; left: 0; top: auto;
    width: 100%;
    border-radius: 12px 12px 0 0;
    transform: none;
  }
}
/**
 * Inline mode — for the hosted page (/s/:slug) and host apps that
 * embed the survey inside a layout column instead of overlaying.
 * Drops the fixed positioning + shadow so the modal lays out as a
 * regular block element filling its mount container.
 */
[${ROOT_ATTR}][data-sankofa-pulse-inline="true"] {
  position: relative;
  bottom: auto; right: auto;
  /* Even in inline / hosted-page mode the survey is always a real
     card — it never stretches to fill its parent. */
  width: min(420px, 100%);
  margin-left: auto;
  margin-right: auto;
  box-shadow: none;
  z-index: auto;
}
@media (prefers-color-scheme: dark) {
  [${ROOT_ATTR}]:not([data-sankofa-pulse-mode="light"]) {
    --sankofa-pulse-bg: #0a0a0a;
    --sankofa-pulse-fg: #fafafa;
    --sankofa-pulse-muted: #a1a1aa;
    --sankofa-pulse-border: #27272a;
  }
}
[${ROOT_ATTR}][data-sankofa-pulse-mode="dark"] {
  --sankofa-pulse-bg: #0a0a0a;
  --sankofa-pulse-fg: #fafafa;
  --sankofa-pulse-muted: #a1a1aa;
  --sankofa-pulse-border: #27272a;
}
[${ROOT_ATTR}] .sankofa-pulse-logo {
  height: 18px; width: auto;
  display: inline-block;
  vertical-align: middle;
  margin-right: 8px;
  border-radius: 2px;
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
  padding: 16px;
  /* Tight pixel ceiling so the card stays usable inside small
     viewports (mobile bottom-sheet, sidebar embed) where a vh-based
     ceiling would produce a card taller than the page. */
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
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
[${ROOT_ATTR}] .sankofa-pulse-scale-btn:hover {
  /* Explicit transparent bg + accent border. Both are needed
     because a host's 'button:hover { background, color }' rule has
     0,2,1 specificity — same as ours — so we must redeclare every
     bleed-prone property on hover, otherwise the host wins on
     source-order tiebreak. */
  background: transparent;
  border-color: var(--sankofa-pulse-accent);
  color: inherit;
}
[${ROOT_ATTR}] .sankofa-pulse-scale-btn:focus,
[${ROOT_ATTR}] .sankofa-pulse-scale-btn:active {
  background: transparent;
  color: inherit;
}
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
[${ROOT_ATTR}] .sankofa-pulse-option-btn:hover {
  background: transparent;
  border-color: var(--sankofa-pulse-accent);
  color: inherit;
}
[${ROOT_ATTR}] .sankofa-pulse-option-btn:focus,
[${ROOT_ATTR}] .sankofa-pulse-option-btn:active {
  background: transparent;
  color: inherit;
}
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
[${ROOT_ATTR}] .sankofa-pulse-slider-wrap {
  margin-top: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-slider {
  width: 100%;
  accent-color: var(--sankofa-pulse-accent);
}
[${ROOT_ATTR}] .sankofa-pulse-slider-value {
  display: flex; justify-content: space-between;
  font-size: 11px; color: var(--sankofa-pulse-muted);
  margin-top: 6px;
}
[${ROOT_ATTR}] .sankofa-pulse-slider-current {
  font-weight: 600; color: var(--sankofa-pulse-fg);
}
[${ROOT_ATTR}] .sankofa-pulse-statement {
  margin-top: 12px; padding: 12px;
  font-size: 13px; color: var(--sankofa-pulse-muted);
  background: rgba(244, 63, 94, 0.04);
  border-left: 3px solid var(--sankofa-pulse-accent);
  border-radius: 4px;
  white-space: pre-wrap;
}
[${ROOT_ATTR}] .sankofa-pulse-ranking {
  display: flex; flex-direction: column; gap: 6px; margin-top: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--sankofa-pulse-border);
  border-radius: 6px;
  background: transparent;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-handle {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
  color: var(--sankofa-pulse-bg);
  background: var(--sankofa-pulse-fg);
  border-radius: 50%;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-label {
  flex: 1; font-size: 13px;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-controls {
  display: flex; gap: 4px;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-btn {
  background: transparent; color: var(--sankofa-pulse-muted);
  border: 1px solid var(--sankofa-pulse-border); border-radius: 4px;
  font-size: 12px; padding: 2px 8px; cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-btn:disabled {
  opacity: 0.3; cursor: not-allowed;
}
[${ROOT_ATTR}] .sankofa-pulse-rank-btn:hover:not(:disabled) {
  color: var(--sankofa-pulse-fg);
  border-color: var(--sankofa-pulse-accent);
}
[${ROOT_ATTR}] .sankofa-pulse-matrix {
  margin-top: 12px;
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-matrix th,
[${ROOT_ATTR}] .sankofa-pulse-matrix td {
  text-align: center;
  padding: 6px 4px;
  border-bottom: 1px solid var(--sankofa-pulse-border);
}
[${ROOT_ATTR}] .sankofa-pulse-matrix th:first-child,
[${ROOT_ATTR}] .sankofa-pulse-matrix td:first-child {
  text-align: left;
  color: var(--sankofa-pulse-muted);
  font-weight: 500;
}
[${ROOT_ATTR}] .sankofa-pulse-matrix-radio {
  accent-color: var(--sankofa-pulse-accent);
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-consent {
  display: flex; align-items: flex-start; gap: 10px;
  margin-top: 12px; padding: 10px;
  border: 1px solid var(--sankofa-pulse-border);
  border-radius: 6px;
}
[${ROOT_ATTR}] .sankofa-pulse-consent-checkbox {
  margin-top: 2px;
  accent-color: var(--sankofa-pulse-accent);
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-consent-text {
  font-size: 12px; line-height: 1.5;
  color: var(--sankofa-pulse-muted);
}
[${ROOT_ATTR}] .sankofa-pulse-image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px; margin-top: 12px;
}
[${ROOT_ATTR}] .sankofa-pulse-image-tile {
  display: flex; flex-direction: column; align-items: center;
  gap: 4px;
  padding: 6px;
  background: transparent;
  border: 1px solid var(--sankofa-pulse-border);
  border-radius: 8px;
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-image-tile:hover {
  border-color: var(--sankofa-pulse-accent);
}
[${ROOT_ATTR}] .sankofa-pulse-image-tile[data-selected="true"] {
  border-color: var(--sankofa-pulse-accent);
  background: rgba(244, 63, 94, 0.08);
}
[${ROOT_ATTR}] .sankofa-pulse-image-tile img {
  width: 100%; aspect-ratio: 1 / 1;
  object-fit: cover; border-radius: 4px;
  background: var(--sankofa-pulse-border);
}
[${ROOT_ATTR}] .sankofa-pulse-image-tile-label {
  font-size: 11px; color: var(--sankofa-pulse-fg);
  text-align: center; line-height: 1.3;
}
[${ROOT_ATTR}] .sankofa-pulse-maxdiff {
  width: 100%; border-collapse: collapse; margin-top: 8px;
}
[${ROOT_ATTR}] .sankofa-pulse-maxdiff th,
[${ROOT_ATTR}] .sankofa-pulse-maxdiff td {
  padding: 6px 8px; text-align: center;
  border-bottom: 1px solid var(--sankofa-pulse-border);
}
[${ROOT_ATTR}] .sankofa-pulse-maxdiff th {
  font-size: 11px; color: var(--sankofa-pulse-muted);
  text-transform: uppercase; letter-spacing: .04em;
}
[${ROOT_ATTR}] .sankofa-pulse-maxdiff-label {
  text-align: left !important; color: var(--sankofa-pulse-fg);
}
[${ROOT_ATTR}] .sankofa-pulse-signature {
  display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
}
[${ROOT_ATTR}] .sankofa-pulse-signature-canvas {
  border: 1px dashed var(--sankofa-pulse-border);
  border-radius: 6px;
  background: var(--sankofa-pulse-bg);
  cursor: crosshair;
  max-width: 100%;
}
[${ROOT_ATTR}] .sankofa-pulse-signature-clear {
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--sankofa-pulse-border);
  color: var(--sankofa-pulse-muted);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-signature-clear:hover {
  color: var(--sankofa-pulse-fg);
  border-color: var(--sankofa-pulse-fg);
}
[${ROOT_ATTR}] .sankofa-pulse-file {
  display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
}
[${ROOT_ATTR}] .sankofa-pulse-file-input {
  font-size: 12px; color: var(--sankofa-pulse-fg);
}
[${ROOT_ATTR}] .sankofa-pulse-file-status {
  font-size: 11px; color: var(--sankofa-pulse-muted);
  min-height: 14px;
}
[${ROOT_ATTR}] .sankofa-pulse-payment {
  display: flex; flex-direction: column; gap: 8px; margin-top: 8px;
}
[${ROOT_ATTR}] .sankofa-pulse-payment-button {
  align-self: flex-start;
  background: var(--sankofa-pulse-accent);
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
[${ROOT_ATTR}] .sankofa-pulse-payment-button:disabled {
  opacity: .6; cursor: not-allowed;
}
[${ROOT_ATTR}] .sankofa-pulse-payment-status {
  font-size: 11px; color: var(--sankofa-pulse-muted);
  min-height: 14px;
}
[${ROOT_ATTR}] .sankofa-pulse-attribution {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 8px 16px;
  border-top: 1px solid var(--sankofa-pulse-border);
  background: transparent;
  font-size: 10px;
  color: var(--sankofa-pulse-muted);
  letter-spacing: .02em;
}
[${ROOT_ATTR}] .sankofa-pulse-attribution a {
  color: inherit;
  font-weight: 600;
  text-decoration: none;
  display: inline-flex; align-items: center; gap: 4px;
}
[${ROOT_ATTR}] .sankofa-pulse-attribution a:hover {
  color: var(--sankofa-pulse-fg);
}
[${ROOT_ATTR}] .sankofa-pulse-attribution-icon {
  /* Inline brand icon. Width/height matched to the attribution
     line-height so the icon visually centers with the text. */
  width: 12px; height: 12px;
  display: inline-block;
  vertical-align: middle;
  border-radius: 2px;
  object-fit: contain;
  /* No filter — render the icon at its natural color so brand
     identity is preserved on dark + light themes. */
}
`;

export class SurveyRenderer {
  private state: SurveyState;
  private bundle: SurveyBundle;
  private root: HTMLElement;
  private mount: HTMLElement;
  private opts: RendererOptions;
  private translator: Translator | null;
  private currentError: string | null = null;
  private dismissed = false;

  constructor(opts: RendererOptions) {
    this.bundle = opts.bundle;
    this.opts = opts;
    this.mount = opts.mount ?? document.body;
    this.translator = buildTranslator(opts.bundle, opts.locale);
    ensureStyles();
    this.state = new SurveyState(
      opts.bundle.questions,
      opts.bundle.branching_rules,
      opts.bundle.partial?.answers ?? {},
      opts.bundle.partial?.current_question_id,
    );
    this.root = document.createElement('div');
    this.root.setAttribute(ROOT_ATTR, '');
    if (opts.inline) {
      this.root.setAttribute('data-sankofa-pulse-inline', 'true');
    }
    // Apply per-survey theme — color overrides land as inline CSS
    // variables on the root, dark-mode override flips an attribute,
    // custom CSS appends one scoped <style>, and any logo URL gets
    // remembered for renderHeader. None of this leaks past the
    // root because the base stylesheet is scoped under [ROOT_ATTR].
    if (opts.bundle.theme) applyTheme(this.root, opts.bundle.theme);
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
    renderInput(
      q,
      valueRef,
      () => this.onAnswerChange(q, valueRef.current),
      inputContainer,
      this.translator,
    );
    if (this.currentError) {
      const errEl = document.createElement('div');
      errEl.className = 'sankofa-pulse-error';
      errEl.textContent = this.currentError;
      body.appendChild(errEl);
    }
    this.root.appendChild(body);
    this.root.appendChild(this.renderFooter(q, snap, valueRef));
    this.root.appendChild(renderAttribution());
  }

  private renderHeader(survey: Survey, idx: number, total: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'sankofa-pulse-header';
    const title = document.createElement('div');
    title.className = 'sankofa-pulse-title';
    // Logo before the survey name when one is themed in.
    if (this.bundle.theme?.logo_url) {
      const logo = document.createElement('img');
      logo.className = 'sankofa-pulse-logo';
      logo.src = this.bundle.theme.logo_url;
      logo.alt = survey.name;
      title.appendChild(logo);
    }
    const localizedName = this.translator?.surveyName(survey) ?? survey.name;
    const text = document.createElement('span');
    text.textContent = localizedName;
    title.appendChild(text);
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
    prompt.textContent = this.translator?.questionPrompt(q) ?? q.prompt;
    wrap.appendChild(prompt);
    const helpText = this.translator?.questionHelptext(q) ?? q.helptext;
    if (helpText) {
      const help = document.createElement('div');
      help.className = 'sankofa-pulse-helptext';
      help.textContent = helpText;
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
    this.root.appendChild(renderAttribution());
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

// ── Attribution footer ─────────────────────────────────────────────
//
// Powered-by-Sankofa link rendered at the bottom of every survey
// card. The attribution is part of the SDK render contract — if you
// want to suppress it, use the white-label tier on the dashboard
// (sets `theme.hide_attribution`, which the renderer reads to skip
// this element). The DOM here is mirrored verbatim by the dashboard
// preview so what an operator sees during theme editing matches what
// respondents see in production.
function renderAttribution(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-attribution';
  const link = document.createElement('a');
  link.href = 'https://sankofa.dev?utm_source=pulse_survey';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const icon = document.createElement('img');
  icon.className = 'sankofa-pulse-attribution-icon';
  icon.src = BRAND_ICON_DATA_URL;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  // Decoded eagerly so the image is on the wire before paint —
  // otherwise the data URL still triggers a microtask delay that
  // shows a broken-image flash on slower devices.
  icon.decoding = 'sync';
  link.appendChild(icon);
  link.appendChild(document.createTextNode('Powered by Sankofa'));
  wrap.appendChild(link);
  return wrap;
}

// ── Per-kind input renderers ───────────────────────────────────────

function renderInput(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
  translator: Translator | null,
): void {
  const renderer = kindRenderers[q.kind] ?? renderUnsupported;
  renderer(q, valueRef, onChange, container, translator);
}

type KindRenderer = (
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
  translator: Translator | null,
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
  slider: renderSlider,
  date: renderDate,
  statement: renderStatement,
  ranking: renderRanking,
  matrix: renderMatrix,
  consent: renderConsent,
  image_choice: renderImageChoice,
  maxdiff: renderMaxDiff,
  signature: renderSignature,
  file: renderFile,
  payment: renderPayment,
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
  translator: Translator | null,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-options';
  (q.options ?? []).forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sankofa-pulse-option-btn';
    btn.textContent = translator?.optionLabel(q, opt) ?? opt.label;
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
  translator: Translator | null,
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
    btn.textContent = translator?.optionLabel(q, opt) ?? opt.label;
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

function renderSlider(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const min = q.validation?.min ?? 0;
  const max = q.validation?.max ?? 100;
  const step = q.validation?.step ?? (Number.isInteger(min) && Number.isInteger(max) ? 1 : 0.01);
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-slider-wrap';

  const initial =
    typeof valueRef.current === 'number' ? valueRef.current : (min + max) / 2;
  // Seed valueRef so a "Next" without interaction still records
  // the displayed default. Matches user expectation when the
  // slider thumb is visually positioned at the midpoint.
  if (typeof valueRef.current !== 'number') {
    valueRef.current = initial;
  }

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'sankofa-pulse-slider';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);

  const value = document.createElement('div');
  value.className = 'sankofa-pulse-slider-value';
  const minSpan = document.createElement('span');
  minSpan.textContent = String(min);
  const current = document.createElement('span');
  current.className = 'sankofa-pulse-slider-current';
  current.textContent = String(initial);
  const maxSpan = document.createElement('span');
  maxSpan.textContent = String(max);
  value.appendChild(minSpan);
  value.appendChild(current);
  value.appendChild(maxSpan);

  input.addEventListener('input', () => {
    const n = Number(input.value);
    valueRef.current = n;
    current.textContent = String(n);
    onChange();
  });

  wrap.appendChild(input);
  wrap.appendChild(value);
  container.appendChild(wrap);
}

function renderDate(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const input = document.createElement('input');
  // <input type="date"> emits YYYY-MM-DD which the server's
  // parseDateAnswer accepts directly. No timezone gymnastics —
  // the date the user picked is the date the server stores.
  input.type = 'date';
  input.className = 'sankofa-pulse-input';
  if (q.validation?.min_date) input.min = q.validation.min_date;
  if (q.validation?.max_date) input.max = q.validation.max_date;
  if (typeof valueRef.current === 'string') input.value = valueRef.current;
  input.addEventListener('input', () => {
    const v = input.value.trim();
    valueRef.current = v === '' ? undefined : v;
    onChange();
  });
  container.appendChild(input);
}

function renderStatement(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  _onChange: () => void,
  container: HTMLElement,
): void {
  // Statements are read-only display elements — the prompt is
  // already rendered above; here we inject the helptext as a
  // styled callout. We DO seed valueRef to undefined so the
  // server gets a clean skip on submit.
  valueRef.current = undefined;
  if (q.helptext && q.helptext.trim() !== '') {
    const note = document.createElement('div');
    note.className = 'sankofa-pulse-statement';
    note.textContent = q.helptext;
    container.appendChild(note);
  }
}

function renderRanking(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
  translator: Translator | null,
): void {
  const options = q.options ?? [];
  if (options.length === 0) return;

  // Initial order: the existing answer if it parses, otherwise the
  // option-list order. The server requires a full ranking, so we
  // never render a partial list — every option is always present.
  const initial = Array.isArray(valueRef.current)
    ? (valueRef.current as string[])
    : [];
  const initialKeys = new Set(initial);
  const ordered = [
    ...initial.filter((k) => options.some((o) => o.key === k)),
    ...options.map((o) => o.key).filter((k) => !initialKeys.has(k)),
  ];
  valueRef.current = ordered;

  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-ranking';
  container.appendChild(wrap);

  const repaint = () => {
    wrap.innerHTML = '';
    const current = valueRef.current as string[];
    current.forEach((key, idx) => {
      const opt = options.find((o) => o.key === key);
      if (!opt) return;
      const row = document.createElement('div');
      row.className = 'sankofa-pulse-rank-row';

      const handle = document.createElement('span');
      handle.className = 'sankofa-pulse-rank-handle';
      handle.textContent = String(idx + 1);

      const label = document.createElement('span');
      label.className = 'sankofa-pulse-rank-label';
      label.textContent = translator?.optionLabel(q, opt) ?? opt.label;

      const controls = document.createElement('div');
      controls.className = 'sankofa-pulse-rank-controls';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'sankofa-pulse-rank-btn';
      up.textContent = '↑';
      up.disabled = idx === 0;
      up.addEventListener('click', () => {
        if (idx === 0) return;
        const next = [...current];
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        valueRef.current = next;
        repaint();
        onChange();
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'sankofa-pulse-rank-btn';
      down.textContent = '↓';
      down.disabled = idx === current.length - 1;
      down.addEventListener('click', () => {
        if (idx === current.length - 1) return;
        const next = [...current];
        [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
        valueRef.current = next;
        repaint();
        onChange();
      });
      controls.appendChild(up);
      controls.appendChild(down);

      row.appendChild(handle);
      row.appendChild(label);
      row.appendChild(controls);
      wrap.appendChild(row);
    });
  };
  repaint();
}

function renderMatrix(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const rows = q.validation?.rows ?? [];
  const cols = q.validation?.columns ?? [];
  if (rows.length === 0 || cols.length === 0) return;

  const initial =
    valueRef.current && typeof valueRef.current === 'object' && !Array.isArray(valueRef.current)
      ? { ...(valueRef.current as Record<string, string>) }
      : ({} as Record<string, string>);
  valueRef.current = initial;

  const table = document.createElement('table');
  table.className = 'sankofa-pulse-matrix';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  cols.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.textContent = r.label;
    tr.appendChild(labelCell);
    cols.forEach((c) => {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `matrix-${q.id}-${r.key}`;
      input.className = 'sankofa-pulse-matrix-radio';
      input.value = c.key;
      input.checked = initial[r.key] === c.key;
      input.addEventListener('change', () => {
        const next = { ...(valueRef.current as Record<string, string>) };
        next[r.key] = c.key;
        valueRef.current = next;
        onChange();
      });
      cell.appendChild(input);
      tr.appendChild(cell);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderConsent(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
  translator: Translator | null,
): void {
  // Consent stores `true` only — explicit affirmative consent.
  // Initial valueRef preserved across re-renders (e.g. back-button
  // path) so a respondent who already ticked doesn't lose the
  // checked state.
  const wrap = document.createElement('label');
  wrap.className = 'sankofa-pulse-consent';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'sankofa-pulse-consent-checkbox';
  checkbox.checked = valueRef.current === true;

  const text = document.createElement('span');
  text.className = 'sankofa-pulse-consent-text';
  // The legal copy lives in helptext per the composer convention.
  // Prompt above already shows the short label ("I agree…");
  // helptext carries the long-form disclosure.
  text.textContent =
    translator?.questionHelptext(q) ?? q.helptext ?? 'I agree.';

  checkbox.addEventListener('change', () => {
    valueRef.current = checkbox.checked ? true : undefined;
    onChange();
  });

  wrap.appendChild(checkbox);
  wrap.appendChild(text);
  container.appendChild(wrap);
}

function renderImageChoice(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
  translator: Translator | null,
): void {
  const options = q.options ?? [];
  if (options.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'sankofa-pulse-image-grid';

  options.forEach((opt) => {
    const localizedLabel = translator?.optionLabel(q, opt) ?? opt.label;
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sankofa-pulse-image-tile';
    tile.dataset.selected = valueRef.current === opt.key ? 'true' : 'false';

    if (opt.image_url) {
      const img = document.createElement('img');
      img.src = opt.image_url;
      img.alt = localizedLabel;
      img.loading = 'lazy';
      tile.appendChild(img);
    }

    const label = document.createElement('span');
    label.className = 'sankofa-pulse-image-tile-label';
    label.textContent = localizedLabel;
    tile.appendChild(label);

    tile.addEventListener('click', () => {
      valueRef.current = opt.key;
      onChange();
      Array.from(grid.children).forEach((c) => {
        const el = c as HTMLElement;
        el.dataset.selected = el === tile ? 'true' : 'false';
      });
    });

    grid.appendChild(tile);
  });

  container.appendChild(grid);
}

/**
 * MaxDiff: best/worst scaling. Renderer is a two-column radio group
 * — a "best" column on the left, a "worst" column on the right,
 * with the option labels between them. Mutually exclusive: clicking
 * the same row in both columns auto-clears the other (the server
 * rejects best == worst, so we forbid it client-side too).
 *
 * State shape: { best: string | undefined, worst: string | undefined }
 * — flat object so the submit path can JSON.stringify directly.
 */
function renderMaxDiff(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const options = q.options ?? [];
  if (options.length < 2) return;

  type State = { best?: string; worst?: string };
  const initial: State =
    valueRef.current && typeof valueRef.current === 'object' && !Array.isArray(valueRef.current)
      ? { ...(valueRef.current as State) }
      : {};
  valueRef.current = initial;

  const table = document.createElement('table');
  table.className = 'sankofa-pulse-maxdiff';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Best', '', 'Worst'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement('tbody');
  options.forEach((opt) => {
    const row = document.createElement('tr');

    const bestCell = document.createElement('td');
    const bestInput = document.createElement('input');
    bestInput.type = 'radio';
    bestInput.name = `maxdiff-best-${q.id}`;
    bestInput.value = opt.key;
    bestInput.checked = initial.best === opt.key;
    bestInput.addEventListener('change', () => {
      const next: State = { ...(valueRef.current as State) };
      next.best = opt.key;
      // If the same row was the worst pick, clear it — best ==
      // worst is invalid server-side.
      if (next.worst === opt.key) next.worst = undefined;
      valueRef.current = next;
      onChange();
      // Re-render disabled states so the worst column reflects the
      // new constraint without a full re-render.
      refreshDisabled();
    });
    bestCell.appendChild(bestInput);

    const labelCell = document.createElement('td');
    labelCell.className = 'sankofa-pulse-maxdiff-label';
    labelCell.textContent = opt.label;

    const worstCell = document.createElement('td');
    const worstInput = document.createElement('input');
    worstInput.type = 'radio';
    worstInput.name = `maxdiff-worst-${q.id}`;
    worstInput.value = opt.key;
    worstInput.checked = initial.worst === opt.key;
    worstInput.addEventListener('change', () => {
      const next: State = { ...(valueRef.current as State) };
      next.worst = opt.key;
      if (next.best === opt.key) next.best = undefined;
      valueRef.current = next;
      onChange();
      refreshDisabled();
    });
    worstCell.appendChild(worstInput);

    row.appendChild(bestCell);
    row.appendChild(labelCell);
    row.appendChild(worstCell);
    body.appendChild(row);
  });
  table.appendChild(body);
  container.appendChild(table);

  // Disable the "best" radio of the row currently picked as worst
  // (and vice versa) so the user can't even attempt the invalid
  // pairing. The change handler above also clears it; this is the
  // visual companion.
  function refreshDisabled() {
    const state = valueRef.current as State;
    table.querySelectorAll('input[type="radio"]').forEach((el) => {
      const input = el as HTMLInputElement;
      const isBest = input.name.startsWith('maxdiff-best-');
      const conflict = isBest
        ? state.worst === input.value
        : state.best === input.value;
      input.disabled = conflict && !input.checked;
    });
  }
  refreshDisabled();
}

/**
 * Signature: hand-drawn input on a <canvas>. Captures pointer
 * events (mouse + touch + stylus) and exports as a PNG data URI on
 * change. Includes a Clear button — clearing returns the answer to
 * "skipped" so the Required gate kicks in if the user un-signs.
 *
 * Validation block can carry {"max_kb": 500}; we don't preflight
 * that on the client (server enforces) but we do cap canvas size
 * so casual scribbles stay well under the limit. A 600×200 PNG
 * with typical signature density runs ~5-30 KB.
 */
function renderSignature(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-signature';

  const canvas = document.createElement('canvas');
  canvas.className = 'sankofa-pulse-signature-canvas';
  // Logical drawing surface — devicePixelRatio scaling lifts crispness
  // on retina without doubling the export size.
  const cssWidth = 600;
  const cssHeight = 200;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  // Cooperate with touch gesture handling — preventDefault on
  // pointermove so vertical strokes don't scroll the page.
  canvas.style.touchAction = 'none';

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#18181b';
  }

  // Restore prior signature if the renderer is re-mounted (back
  // navigation across questions).
  let dirty = false;
  if (typeof valueRef.current === 'string' && valueRef.current.startsWith('data:image/')) {
    dirty = true;
    const img = new Image();
    img.onload = () => ctx?.drawImage(img, 0, 0, cssWidth, cssHeight);
    img.src = valueRef.current as string;
  }

  let drawing = false;
  let lastX = 0;
  let lastY = 0;

  const point = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = point(e);
    lastX = x;
    lastY = y;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !ctx) return;
    e.preventDefault();
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x;
    lastY = y;
    dirty = true;
  });
  const endStroke = (e: PointerEvent) => {
    if (!drawing) return;
    drawing = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (dirty) {
      valueRef.current = canvas.toDataURL('image/png');
      onChange();
    }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'sankofa-pulse-signature-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    if (!ctx) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    dirty = false;
    valueRef.current = undefined;
    onChange();
  });

  wrap.appendChild(canvas);
  wrap.appendChild(clearBtn);
  container.appendChild(wrap);

  void q;
}

/**
 * File upload. Two-stage: the user picks a file, the SDK uploads
 * to whatever endpoint the host configured, and the answer carries
 * the resulting URL + metadata.
 *
 * For v1 the upload endpoint is window-level config — host apps set
 * `window.__sankofaPulseUploadURL` to a server route that accepts a
 * multipart POST and returns `{url, name?, size_bytes?, mime_type?}`.
 * Without that endpoint, the renderer falls back to embedding a
 * data URI (suitable only for small files; capped at 1 MB to avoid
 * blowing the response payload). Either path produces the same
 * answer shape the server expects.
 */
function renderFile(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-file';

  const validation = (q.validation ?? {}) as {
    accept?: string[];
    max_kb?: number;
  };
  const maxKB = validation.max_kb && validation.max_kb > 0 ? validation.max_kb : 10240;
  const accept = (validation.accept ?? []).join(',');

  const input = document.createElement('input');
  input.type = 'file';
  input.className = 'sankofa-pulse-file-input';
  if (accept) input.accept = accept;

  const status = document.createElement('div');
  status.className = 'sankofa-pulse-file-status';

  const renderStatus = () => {
    const v = valueRef.current as
      | { name?: string; size_bytes?: number; url?: string }
      | undefined;
    if (!v || !v.url) {
      status.textContent = '';
      return;
    }
    const sizeKB = v.size_bytes ? Math.round(v.size_bytes / 1024) : 0;
    status.textContent = `${v.name ?? 'attachment'}${sizeKB ? ` · ${sizeKB} KB` : ''}`;
  };

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > maxKB * 1024) {
      status.textContent = `File too large (max ${maxKB} KB)`;
      input.value = '';
      return;
    }
    status.textContent = 'Uploading…';
    try {
      const result = await uploadFile(file);
      valueRef.current = result;
      renderStatus();
      onChange();
    } catch (err) {
      status.textContent =
        err instanceof Error ? `Upload failed: ${err.message}` : 'Upload failed';
      valueRef.current = undefined;
      onChange();
    }
  });

  wrap.appendChild(input);
  wrap.appendChild(status);
  container.appendChild(wrap);
  renderStatus();
}

interface UploadedFile {
  url: string;
  name?: string;
  size_bytes?: number;
  mime_type?: string;
}

async function uploadFile(file: File): Promise<UploadedFile> {
  const endpoint =
    typeof window !== 'undefined'
      ? ((window as unknown as { __sankofaPulseUploadURL?: string })
          .__sankofaPulseUploadURL ?? '')
      : '';

  if (endpoint) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<UploadedFile>;
    if (!body.url) throw new Error('upload endpoint returned no url');
    return {
      url: body.url,
      name: body.name ?? file.name,
      size_bytes: body.size_bytes ?? file.size,
      mime_type: body.mime_type ?? file.type,
    };
  }

  // No upload endpoint — embed as data URI. Capped at 1 MB so we
  // don't ship a huge base64 blob in the response payload.
  if (file.size > 1024 * 1024) {
    throw new Error(
      'no upload endpoint configured (window.__sankofaPulseUploadURL); files >1MB rejected in fallback mode',
    );
  }
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
  return {
    url: dataURL,
    name: file.name,
    size_bytes: file.size,
    mime_type: file.type,
  };
}

/**
 * Payment: confirms a Stripe / Paystack-style payment intent. The
 * actual payment flow is the host's responsibility — we expose a
 * "Pay …" button that calls window.__sankofaPulsePay (a host-
 * configured async function) and stores the resulting intent
 * confirmation as the answer.
 *
 * Without a configured payment handler, the renderer shows an
 * inline note instructing the host to wire up __sankofaPulsePay.
 * No mock / stub mode — payments are too sensitive to fake.
 */
function renderPayment(
  q: SurveyQuestion,
  valueRef: { current: unknown },
  onChange: () => void,
  container: HTMLElement,
): void {
  const validation = (q.validation ?? {}) as {
    amount_min?: number;
    amount_max?: number;
    amount?: number;
    currency?: string;
  };
  const amount = validation.amount ?? validation.amount_min ?? 0;
  const currency = (validation.currency ?? 'USD').toUpperCase();

  const wrap = document.createElement('div');
  wrap.className = 'sankofa-pulse-payment';

  const status = document.createElement('div');
  status.className = 'sankofa-pulse-payment-status';

  const handler =
    typeof window !== 'undefined'
      ? (window as unknown as {
          __sankofaPulsePay?: (req: {
            amount: number;
            currency: string;
            question_id: string;
          }) => Promise<{
            intent_id: string;
            status: string;
            amount?: number;
            currency?: string;
          }>;
        }).__sankofaPulsePay
      : undefined;

  const renderConfirmation = () => {
    const v = valueRef.current as
      | { intent_id?: string; status?: string }
      | undefined;
    if (v?.intent_id) {
      status.textContent = `Confirmed · ${v.status ?? 'submitted'} · ${v.intent_id}`;
    }
  };

  if (!handler) {
    status.textContent =
      'Payment handler not configured. Set window.__sankofaPulsePay to enable.';
    wrap.appendChild(status);
    container.appendChild(wrap);
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sankofa-pulse-payment-button';
  button.textContent = `Pay ${formatAmount(amount, currency)}`;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Processing…';
    try {
      const result = await handler({
        amount,
        currency: currency.toLowerCase(),
        question_id: q.id,
      });
      valueRef.current = {
        intent_id: result.intent_id,
        status: result.status,
        amount: result.amount ?? amount,
        currency: (result.currency ?? currency).toLowerCase(),
      };
      renderConfirmation();
      onChange();
    } catch (err) {
      status.textContent =
        err instanceof Error ? `Payment failed: ${err.message}` : 'Payment failed';
      button.disabled = false;
    }
  });

  wrap.appendChild(button);
  wrap.appendChild(status);
  container.appendChild(wrap);
  renderConfirmation();
}

function formatAmount(amount: number, currency: string): string {
  if (typeof Intl !== 'undefined') {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).format(amount);
    } catch {
      /* fall through */
    }
  }
  return `${amount} ${currency}`;
}

function renderUnsupported(
  q: SurveyQuestion,
  _valueRef: { current: unknown },
  _onChange: () => void,
  container: HTMLElement,
): void {
  // Phase 1 covers all 15 server-side kinds with this renderer.
  // Future kinds (e.g. voice, file_upload, signature) land here
  // until their dedicated renderer ships — visible placeholder so
  // operators notice instead of silent skip.
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

/**
 * Apply per-survey theme to the renderer root. Color overrides
 * land as inline CSS variables so they win cleanly over the
 * defaults set in STYLES; dark-mode override flips a data
 * attribute the stylesheet keys off; custom CSS appends one
 * scoped <style> tag namespaced under [ROOT_ATTR] so two
 * concurrent surveys don't fight over selectors.
 *
 * Idempotent — calling applyTheme twice replaces prior overrides
 * cleanly (style block carries an id derived from the root).
 */
// Closed allowlist mirrored from server/engine/ee/pulse/models_theme.go
// validPositions. Adding a new entry here requires a matching CSS
// selector in the STYLES block above; absent that, the renderer
// silently falls back to bottom-right.
const SUPPORTED_POSITIONS = new Set<string>([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
]);

function applyTheme(root: HTMLElement, theme: SurveyTheme): void {
  const styleVarMap: Array<[string, string | undefined]> = [
    ['--sankofa-pulse-accent', theme.primary_color],
    ['--sankofa-pulse-bg', theme.background_color],
    ['--sankofa-pulse-fg', theme.foreground_color],
    ['--sankofa-pulse-muted', theme.muted_color],
    ['--sankofa-pulse-border', theme.border_color],
  ];
  for (const [name, value] of styleVarMap) {
    if (value && value.trim() !== '') {
      root.style.setProperty(name, value);
    }
  }
  if (theme.font_family && theme.font_family.trim() !== '') {
    root.style.setProperty('font-family', theme.font_family);
  }
  if (theme.dark_mode === 'light' || theme.dark_mode === 'dark') {
    root.setAttribute('data-sankofa-pulse-mode', theme.dark_mode);
  }
  // Position attribute drives the corner / centre selectors above.
  // Allowlist mirrors validPositions in models_theme.go — anything
  // outside it falls through to the default bottom-right.
  if (theme.position && SUPPORTED_POSITIONS.has(theme.position)) {
    root.setAttribute('data-sankofa-pulse-position', theme.position);
  }
  if (theme.custom_css && theme.custom_css.trim() !== '') {
    // Append the operator's CSS as a sibling <style>. We don't
    // auto-scope it because reliably wrapping arbitrary CSS in a
    // parent selector requires real parsing — wrapping in
    // `[ROOT_ATTR] { ... }` works for declarations but breaks
    // the moment the operator writes a rule (`.x { color: red }`
    // would parse as a declaration with value `{ color: red }`).
    //
    // The composer documents that custom_css selectors should
    // begin with `[data-sankofa-pulse-root]` to scope; the only
    // thing that protects the host page from a typo is the
    // operator. Same posture every survey vendor takes for the
    // custom-CSS feature — see Typeform / Sprig docs.
    const styleEl = document.createElement('style');
    styleEl.textContent = theme.custom_css;
    root.appendChild(styleEl);
  }
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
