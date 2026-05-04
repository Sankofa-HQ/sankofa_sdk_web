/**
 * Wire types for the Pulse SDK. These mirror server/engine/ee/pulse/
 * exactly — drift between Go + TS has shipped real bugs before
 * (the QuestionKind enum in the dashboard didn't match the server's
 * allowlist for weeks). Treat this file as the canonical client-side
 * record of what the server promises and rejects.
 */

// ── Core entities ──────────────────────────────────────────────────

export type SurveyKind = 'nps' | 'csat' | 'custom' | 'service_desk';
export type SurveyStatus = 'draft' | 'published' | 'closed';

export interface Survey {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  description?: string;
  kind: SurveyKind;
  status: SurveyStatus;
  /** Slug used by the public hosted URL: /s/:slug. */
  slug?: string;
  published_at?: string | null;
  closed_at?: string | null;
  archived_at?: string | null;
}

/** Closed allowlist matching server validQuestionKinds. */
export type QuestionKind =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'rating'
  | 'nps'
  | 'single'
  | 'multi'
  | 'boolean'
  | 'slider'
  | 'date'
  | 'statement'
  | 'ranking'
  | 'matrix'
  | 'consent'
  | 'image_choice'
  | 'maxdiff'
  | 'signature'
  | 'file'
  | 'payment';

export interface QuestionOption {
  key: string;
  label: string;
  /** ImageChoice carries an image URL alongside the label. */
  image_url?: string;
}

export interface QuestionValidation {
  /** rating + slider + number */
  min?: number;
  /** rating + slider + number */
  max?: number;
  /** slider only */
  step?: number;
  /** date — RFC3339 / YYYY-MM-DD */
  min_date?: string;
  /** date — RFC3339 / YYYY-MM-DD */
  max_date?: string;
  /** matrix only */
  rows?: QuestionOption[];
  /** matrix only */
  columns?: QuestionOption[];
}

export interface SurveyQuestion {
  id: string;
  survey_id: string;
  kind: QuestionKind;
  prompt: string;
  helptext?: string;
  required: boolean;
  order_index: number;
  options?: QuestionOption[] | null;
  validation?: QuestionValidation | null;
}

// ── Targeting (mirrors server/engine/ee/pulse/targeting/types.go) ──

export type RuleKind =
  | 'url'
  | 'screen'
  | 'event'
  | 'user_property'
  | 'cohort'
  | 'sampling'
  | 'frequency_cap'
  | 'feature_flag';

export type MatchOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'prefix'
  | 'regex'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte';

export type FrequencyScope = 'per_user';

export interface TargetingRule {
  kind: RuleKind;
  // url
  url_match?: MatchOp;
  url_value?: string;
  // screen — same shape as url, applied to native screen / route name
  screen_match?: MatchOp;
  screen_name?: string;
  // event
  event_name?: string;
  event_min_count?: number;
  event_window_days?: number;
  // user_property
  property_key?: string;
  property_op?: MatchOp;
  property_value?: unknown;
  // cohort
  cohort_id?: string;
  // sampling
  sampling_rate?: number;
  // frequency_cap
  frequency_scope?: FrequencyScope;
  frequency_max?: number;
  frequency_window_days?: number;
  // feature_flag
  flag_key?: string;
  flag_value?: unknown;
}

export interface EligibilityContext {
  surveyId: string;
  respondentExternalId: string;
  pageUrl?: string;
  /** Native screen / route name (mobile + Flutter SDKs). Empty on
   *  web unless the host explicitly sets a route via plugin options. */
  screenName?: string;
  recentEvents?: Record<string, number>;
  userProperties?: Record<string, unknown>;
  cohorts?: Record<string, boolean>;
  flagValues?: Record<string, unknown>;
  priorResponseCount?: Record<string, number>;
}

export interface Decision {
  eligible: boolean;
  reason?: string;
}

// ── Branching (mirrors server/engine/ee/pulse/branching/types.go) ──

export type BranchingActionKind = 'skip_to' | 'end_survey';

export const BRANCHING_END_OF_SURVEY = '__end__';

export type CondKind = 'answer';

export type CondOp =
  | 'equals'
  | 'not_equals'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'in'
  | 'not_in'
  | 'answered'
  | 'not_answered';

export interface BranchingCondition {
  kind: CondKind;
  question_id: string;
  op: CondOp;
  value?: unknown;
}

export interface BranchingRule {
  from_question_id: string;
  condition: BranchingCondition;
  action: BranchingActionKind;
  to_question_id?: string;
}

export type AnswerState = Record<string, unknown>;

export interface Outcome {
  next_question_id: string; // "" = fall through; "__end__" = end survey
  reason?: string;
}

// ── Renderer-facing aggregate ──────────────────────────────────────

/**
 * Branding row attached to a survey. All fields optional —
 * unset values fall back to the renderer's built-in defaults.
 */
export interface SurveyTheme {
  id?: string;
  survey_id?: string;
  primary_color?: string;
  background_color?: string;
  foreground_color?: string;
  muted_color?: string;
  border_color?: string;
  font_family?: string;
  logo_url?: string;
  /** auto = follow system; light/dark = force palette. */
  dark_mode?: 'auto' | 'light' | 'dark';
  /**
   * Modal position on the viewport. Mobile breakpoints fall back to
   * a bottom-sheet regardless of this value because corner-positioning
   * on a 320-wide screen is unusable. Default: bottom-right.
   */
  position?: SurveyPosition;
  custom_css?: string;
}

export type SurveyPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left'
  | 'center';

/**
 * Per-locale string overrides keyed by path:
 *
 *   "survey.name"
 *   "survey.description"
 *   "question.<question_id>.prompt"
 *   "question.<question_id>.helptext"
 *   "question.<question_id>.option.<option_key>.label"
 *
 * Missing keys fall back to the source string on the survey /
 * question / option object.
 */
export type TranslationStrings = Record<string, string>;

/**
 * Everything the SDK needs to render one survey: the survey row,
 * its questions in order, its targeting + branching rules, the
 * optional theme, per-locale translations, and any resumed
 * partial state. Loaded once via PulseClient.loadSurvey().
 */
export interface SurveyBundle {
  survey: Survey;
  questions: SurveyQuestion[];
  targeting_rules: TargetingRule[];
  branching_rules: BranchingRule[];
  theme?: SurveyTheme | null;
  /** Locale → keyed string map. */
  translations?: Record<string, TranslationStrings>;
  /** Partial state to resume from, if any. */
  partial?: {
    answers: AnswerState;
    current_question_id?: string;
  };
}

/**
 * The shape the SDK ships when finalising. Mirrors the server's
 * ingestPayload — `answers` is keyed by question_id, values are the
 * raw shape the server's coerceAnswer expects.
 */
export interface SubmitPayload {
  survey_id: string;
  respondent: {
    user_id?: string;
    external_id?: string;
    email?: string;
  };
  context?: Record<string, unknown>;
  submitted_at?: string;
  answers: AnswerState;
}

// ── Public API ─────────────────────────────────────────────────────

export interface PulseShowOptions {
  /** Custom DOM mount point. Defaults to <body>. */
  mount?: HTMLElement;
  /** Additional context merged into EligibilityContext + submit payload. */
  context?: Record<string, unknown>;
  /** Override respondent identity for this show call. */
  respondent?: {
    user_id?: string;
    external_id?: string;
    email?: string;
  };
  /** Suppress the eligibility check (force-show). Useful for previews. */
  skipEligibility?: boolean;
  /**
   * BCP-47 locale to render. When matching translation keys exist
   * on the survey, source strings are replaced before render. Falls
   * back to source on miss; falls back further to the browser's
   * preferred locale when undefined.
   */
  locale?: string;
}

export interface SankofaPulseAPI {
  /** Fetch + filter active surveys the current respondent matches. */
  getActiveMatchingSurveys(): Promise<Survey[]>;
  /** Programmatic show — eligibility runs unless skipEligibility is set. */
  show(surveyId: string, options?: PulseShowOptions): Promise<void>;
  /** Dismiss any open survey. No-op when nothing is showing. */
  dismiss(): void;
  /** Subscribe to lifecycle events. Returns an unsubscribe handle. */
  on(event: PulseEvent, listener: PulseEventListener): () => void;
}

export type PulseEvent =
  | 'survey_shown'
  | 'survey_dismissed'
  | 'survey_completed'
  | 'survey_partial_saved';

export type PulseEventListener = (payload: PulseEventPayload) => void;

export interface PulseEventPayload {
  event: PulseEvent;
  survey_id: string;
  response_id?: string;
  reason?: string;
}
