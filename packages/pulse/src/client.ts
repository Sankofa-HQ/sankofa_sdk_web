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

/** Compact projection returned by GET /api/pulse/surveys.
 *  Each entry has everything the SDK needs to:
 *  - run local eligibility evaluation (targeting_rules)
 *  - decide whether to auto-show (auto_show)
 *  - apply per-survey dismiss cooldown (display_cooldown_seconds)
 *  - delay presentation (display_delay_ms)
 *  All four fields are dashboard-controlled — the SDK is purely
 *  policy-enforcement against a server-published config.
 */
export interface PulseSurveySummary {
  id: string;
  name: string;
  description?: string;
  kind: Survey['kind'];
  status: Survey['status'];
  slug?: string;
  targeting_rules: TargetingRule[];
  auto_show: boolean;
  display_cooldown_seconds: number;
  display_delay_ms: number;
}

const SURVEYS_CACHE_PREFIX = 'sankofa.pulse.surveys.';
/** TTL between full revalidations. After this, the SDK sends a
 *  conditional GET — server returns 304 + zero body when unchanged
 *  so steady-state cost is just a HEAD-shaped roundtrip. */
const DEFAULT_LIST_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedSurveysList {
  etag: string;
  fetchedAt: number;
  surveys: PulseSurveySummary[];
}

function readSurveysCache(key: string): CachedSurveysList | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSurveysList;
    if (
      !parsed ||
      typeof parsed.fetchedAt !== 'number' ||
      !Array.isArray(parsed.surveys)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSurveysCache(key: string, value: CachedSurveysList): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode — silently swallow. Worst case is more
    // network round-trips this session, never a broken render.
  }
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

  /**
   * Discover every published survey the API key's project owns.
   * Each summary carries the targeting_rules + display behaviour
   * (auto_show, cooldown, delay) so the SDK can run local
   * eligibility evaluation AND auto-show decisions without
   * round-tripping per page-load / per-navigation. Powers
   * `Sankofa.pulse.getActiveMatchingSurveys()`.
   *
   * Cached in localStorage with ETag + TTL — reads after the first
   * fetch are instant, and revalidations short-circuit to a 304 +
   * empty body when the server hasn't published any changes. The
   * goal is "one full fetch per device per few minutes; 304 the
   * rest" so the engine stays out of the per-event hot path.
   *
   * Returns an empty array on a 404 (older engines without the
   * list endpoint).
   */
  async listSurveys(
    options: { forceRefresh?: boolean; ttlMs?: number } = {},
  ): Promise<PulseSurveySummary[]> {
    const ttlMs = options.ttlMs ?? DEFAULT_LIST_TTL_MS;

    const cached = readSurveysCache(this.cacheKey());
    const now = Date.now();
    if (
      !options.forceRefresh &&
      cached &&
      now - cached.fetchedAt < ttlMs
    ) {
      return cached.surveys;
    }

    const headers: Record<string, string> = {};
    // Conditional GET — server returns 304 + zero body if nothing
    // changed since the cached etag, dropping the per-survey
    // targeting-rule load on the server side.
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    try {
      const res = await fetch(`${this.endpoint}/api/pulse/surveys`, {
        headers: { 'x-api-key': this.apiKey, ...headers },
      });
      if (res.status === 304 && cached) {
        // Refresh the fetchedAt stamp so the TTL window restarts.
        writeSurveysCache(this.cacheKey(), {
          ...cached,
          fetchedAt: now,
        });
        return cached.surveys;
      }
      if (res.status === 404) return [];
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      const etag = res.headers.get('ETag') ?? '';
      const body = (await res.json()) as {
        surveys?: Array<{
          id: string;
          name: string;
          description?: string;
          kind: Survey['kind'];
          status: Survey['status'];
          slug?: string;
          targeting_rules?: TargetingRule[];
          auto_show?: boolean;
          display_cooldown_seconds?: number;
          display_delay_ms?: number;
        }>;
      };
      const surveys: PulseSurveySummary[] = (body.surveys ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        kind: s.kind,
        status: s.status,
        slug: s.slug,
        targeting_rules: s.targeting_rules ?? [],
        auto_show: s.auto_show ?? true,
        display_cooldown_seconds:
          typeof s.display_cooldown_seconds === 'number'
            ? s.display_cooldown_seconds
            : 7 * 24 * 60 * 60,
        display_delay_ms: s.display_delay_ms ?? 0,
      }));
      writeSurveysCache(this.cacheKey(), {
        etag,
        fetchedAt: now,
        surveys,
      });
      return surveys;
    } catch (err) {
      if (cached) {
        // Network failed but we have a stale cache — return it
        // rather than blocking the host UI. Better stale-cached
        // surveys for one tick than a broken modal.
        return cached.surveys;
      }
      throw err;
    }
  }

  /** localStorage cache key — scoped to (endpoint, apiKey) so a
   *  single browser flipping between projects doesn't cross-pollute
   *  cached survey lists. */
  private cacheKey(): string {
    return `${SURVEYS_CACHE_PREFIX}${this.endpoint}|${this.apiKey}`;
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
