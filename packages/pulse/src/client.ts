/**
 * REST client for the public /api/pulse/* endpoints. SDK-facing,
 * x-api-key authenticated. Mirrors the dashboard's api.ts but
 * without the JWT path — the SDK never has a user token.
 *
 * Each call returns the parsed body OR throws an Error with a
 * shape the renderer can show to the user. Error messages copy
 * the server's `error.message` when present so retries / quota
 * exhausted paths produce sensible UI.
 */

import type {
  AnswerState,
  SubmitPayload,
  Survey,
  SurveyBundle,
  SurveyQuestion,
  SurveyTheme,
  TargetingRule,
  BranchingRule,
} from './types';

export interface PulseClientOptions {
  /** API endpoint root, e.g. https://api.sankofa.dev */
  endpoint: string;
  /** Project API key (live or test). */
  apiKey: string;
}

export class PulseClient {
  private endpoint: string;
  private apiKey: string;

  constructor(opts: PulseClientOptions) {
    this.endpoint = trimSlash(opts.endpoint);
    this.apiKey = opts.apiKey;
  }

  /**
   * Fetch the survey definition + questions + rules + any partial
   * state for the given respondent in a single round-trip. The
   * server's /api/pulse/surveys/:id endpoint bundles all five
   * reads — only published surveys are reachable here, and the
   * partial is included automatically when external_id is passed.
   */
  async loadSurvey(
    surveyId: string,
    externalId: string,
  ): Promise<SurveyBundle> {
    const path =
      `/api/pulse/surveys/${encodeURIComponent(surveyId)}` +
      (externalId ? `?external_id=${encodeURIComponent(externalId)}` : '');
    const bundle = await this.fetchJson<{
      survey: Survey;
      questions: SurveyQuestion[];
      targeting_rules: TargetingRule[];
      branching_rules: BranchingRule[];
      theme?: SurveyTheme | null;
      partial?: {
        answers: AnswerState;
        current_question_id?: string;
      } | null;
    }>(path);
    return {
      survey: bundle.survey,
      questions: bundle.questions ?? [],
      targeting_rules: bundle.targeting_rules ?? [],
      branching_rules: bundle.branching_rules ?? [],
      theme: bundle.theme ?? null,
      partial: bundle.partial
        ? {
            answers: bundle.partial.answers ?? {},
            current_question_id: bundle.partial.current_question_id,
          }
        : undefined,
    };
  }

  /**
   * Save in-progress answers + the current question pointer.
   * Idempotent — same (survey_id, external_id) overwrites prior
   * partial. Best-effort from the renderer's perspective: errors
   * log but don't block the user from typing.
   */
  async savePartial(payload: {
    surveyId: string;
    respondent: { user_id?: string; external_id: string; email?: string };
    context?: Record<string, unknown>;
    answers: AnswerState;
    currentQuestionId?: string;
  }): Promise<void> {
    await this.fetchJson('/api/pulse/partial', {
      method: 'POST',
      body: JSON.stringify({
        survey_id: payload.surveyId,
        respondent: payload.respondent,
        context: payload.context,
        answers: payload.answers,
        current_question_id: payload.currentQuestionId,
      }),
    });
  }

  /**
   * Submit the final response. Server validates answers against
   * the question shape + required-question rules; throws on
   * validation failure with the server's shape ({invalid: [...]}
   * or {missing: [...]}).
   */
  async submit(payload: SubmitPayload): Promise<{ id: string; score?: number }> {
    return this.fetchJson<{ id: string; score?: number }>(
      '/api/pulse/responses',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  /** Explicit clear of a partial — used when the respondent says "start over". */
  async deletePartial(surveyId: string, externalId: string): Promise<void> {
    await this.fetchJson(
      `/api/pulse/partial?survey_id=${encodeURIComponent(surveyId)}&external_id=${encodeURIComponent(externalId)}`,
      { method: 'DELETE' },
    );
  }

  // ── Internals ────────────────────────────────────────────────

  private async fetchJson<T>(
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
    };
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.endpoint}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body — surface as a plain string error.
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      return text as unknown as T;
    }
    if (!res.ok) {
      const detail =
        (body as { error?: string; message?: string })?.message ??
        (body as { error?: string })?.error ??
        `HTTP ${res.status}`;
      const err = new Error(String(detail));
      // Attach the parsed body so callers can drill into
      // server-supplied {invalid, missing} arrays for UI hints.
      (err as Error & { body?: unknown }).body = body;
      throw err;
    }
    return body as T;
  }
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
