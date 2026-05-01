/**
 * pulsePlugin() — host apps call this and pass the result to
 * Sankofa.init({ plugins: [...] }). Returns a SankofaPlugin whose
 * setup wires up the public SankofaPulseAPI singleton.
 *
 * Pattern mirrors switchPlugin() in @sankofa/switch — module-level
 * singleton, getPulse() accessor, plugin lifecycle hooks for
 * shutdown + identity changes.
 *
 * No moduleName field yet: the engine-side handshake doesn't carry
 * pulse data in v1, so the Traffic Cop has no payload to route.
 * The SDK fetches survey bundles via dedicated /api/pulse/*
 * endpoints. When the unified handshake lights up pulse, this
 * plugin grows a moduleName + applyHandshake hook.
 */

import type {
  SankofaClientSnapshot,
  SankofaPlugin,
  SankofaPluginContext,
} from '@sankofa/browser';

import { PulseClient } from './client';
import { SurveyRenderer } from './renderer';
import { evaluate as evaluateTargeting } from './targeting';
import type {
  EligibilityContext,
  PulseEvent,
  PulseEventListener,
  PulseEventPayload,
  PulseShowOptions,
  SankofaPulseAPI,
  Survey,
  SurveyBundle,
  TargetingRule,
} from './types';

let singleton: PulseImpl | null = null;

export interface PulsePluginOptions {
  /**
   * Endpoint root for the public ingest API. Defaults to the same
   * endpoint Sankofa.init was given. Override for self-hosted
   * deployments where pulse runs on a different host than analytics.
   */
  endpoint?: string;
  /**
   * Default user_property bag used for eligibility evaluation when
   * the host doesn't pass one per show() call.
   */
  defaultUserProperties?: Record<string, unknown>;
  /**
   * Default cohort membership map. Same fall-through behaviour as
   * defaultUserProperties.
   */
  defaultCohorts?: Record<string, boolean>;
  /**
   * Default flag-value map for KindFeatureFlag rules. Host apps
   * that already cache flag values via @sankofa/switch can pass a
   * snapshot here; otherwise the SDK starts empty (flag-tied
   * surveys won't fire until the host wires this).
   */
  defaultFlagValues?: Record<string, unknown>;
}

class PulseImpl implements SankofaPulseAPI {
  private client: PulseClient;
  private snapshotFn: () => SankofaClientSnapshot;
  private debugFn: (msg: string, ...rest: unknown[]) => void;
  private opts: PulsePluginOptions;
  private listeners: Map<PulseEvent, Set<PulseEventListener>> = new Map();
  private active: SurveyRenderer | null = null;

  constructor(
    client: PulseClient,
    snapshotFn: () => SankofaClientSnapshot,
    debugFn: (msg: string, ...rest: unknown[]) => void,
    opts: PulsePluginOptions,
  ) {
    this.client = client;
    this.snapshotFn = snapshotFn;
    this.debugFn = debugFn;
    this.opts = opts;
  }

  on(event: PulseEvent, listener: PulseEventListener): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket?.delete(listener);
    };
  }

  emit(payload: PulseEventPayload): void {
    const bucket = this.listeners.get(payload.event);
    if (!bucket) return;
    for (const listener of bucket) {
      try {
        listener(payload);
      } catch (err) {
        this.debugFn('listener threw', err);
      }
    }
  }

  /**
   * Best-effort survey discovery. The dashboard-style "list every
   * survey" endpoint is JWT-only; the SDK currently relies on the
   * host knowing which survey ID to show. This stub returns []
   * until we land an SDK-readable list endpoint with eligibility
   * pre-filtering on the server.
   */
  async getActiveMatchingSurveys(): Promise<Survey[]> {
    this.debugFn(
      'getActiveMatchingSurveys: no SDK-readable list endpoint yet — host should pass surveyId to show() directly',
    );
    return [];
  }

  async show(surveyId: string, options: PulseShowOptions = {}): Promise<void> {
    if (this.active) {
      this.debugFn('show: a survey is already visible; dismiss first');
      return;
    }
    const snap = this.snapshotFn();
    const externalId = options.respondent?.external_id ?? snap.anonymousId;
    if (!externalId) {
      this.debugFn('show: cannot resolve external_id; aborting');
      return;
    }

    let bundle: SurveyBundle;
    try {
      bundle = await this.client.loadSurvey(surveyId, externalId);
    } catch (err) {
      this.debugFn('show: loadSurvey failed', err);
      return;
    }

    if (!options.skipEligibility) {
      const decision = evaluateTargeting(bundle.targeting_rules, this.buildContext(surveyId, externalId, options));
      if (!decision.eligible) {
        this.debugFn(`show: eligibility blocked (${decision.reason})`);
        return;
      }
    }

    const respondent = {
      user_id: options.respondent?.user_id ?? snap.identifiedId ?? undefined,
      external_id: externalId,
      email: options.respondent?.email,
    };

    this.active = new SurveyRenderer({
      bundle,
      mount: options.mount,
      locale: options.locale,
      onAnswerChange: ({ answers, currentQuestionId }) => {
        // Save partials in the background. Failure logs but
        // doesn't disrupt the form.
        this.client
          .savePartial({
            surveyId,
            respondent: { ...respondent, external_id: externalId },
            context: this.buildSubmitContext(options),
            answers,
            currentQuestionId,
          })
          .catch((err) => this.debugFn('savePartial failed', err));
        this.emit({
          event: 'survey_partial_saved',
          survey_id: surveyId,
        });
      },
      onComplete: async ({ answers }) => {
        const result = await this.client.submit({
          survey_id: surveyId,
          respondent,
          context: this.buildSubmitContext(options),
          answers,
        });
        this.emit({
          event: 'survey_completed',
          survey_id: surveyId,
          response_id: result.id,
        });
      },
      onDismiss: ({ reason }) => {
        this.active = null;
        this.emit({
          event: 'survey_dismissed',
          survey_id: surveyId,
          reason,
        });
      },
      emit: (p) => this.emit(p),
    });
  }

  dismiss(): void {
    this.active?.dismiss('host');
    this.active = null;
  }

  /**
   * Compose the EligibilityContext for the targeting evaluator.
   * Merges plugin-level defaults with per-show overrides so a
   * host can override one trait without losing the rest.
   */
  private buildContext(
    surveyId: string,
    externalId: string,
    options: PulseShowOptions,
  ): EligibilityContext {
    const ctx = options.context ?? {};
    return {
      surveyId,
      respondentExternalId: externalId,
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
      userProperties: {
        ...(this.opts.defaultUserProperties ?? {}),
        ...(ctx.userProperties as Record<string, unknown> ?? {}),
      },
      cohorts: {
        ...(this.opts.defaultCohorts ?? {}),
        ...(ctx.cohorts as Record<string, boolean> ?? {}),
      },
      flagValues: {
        ...(this.opts.defaultFlagValues ?? {}),
        ...(ctx.flagValues as Record<string, unknown> ?? {}),
      },
      recentEvents: (ctx.recentEvents as Record<string, number>) ?? {},
      priorResponseCount:
        (ctx.priorResponseCount as Record<string, number>) ?? {},
    };
  }

  private buildSubmitContext(options: PulseShowOptions): Record<string, unknown> {
    const ctx = (options.context ?? {}) as Record<string, unknown>;
    if (typeof window !== 'undefined') {
      return {
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        ...ctx,
      };
    }
    return ctx;
  }
}

export function pulsePlugin(options: PulsePluginOptions = {}): SankofaPlugin {
  return {
    name: 'pulse',
    setup(context: SankofaPluginContext) {
      const snap = context.getSnapshot();
      // Reuse the host's apiKey + endpoint. SDK ingest endpoints
      // live under /api/pulse/* on the same host; deriving from
      // batchUrl keeps zero-config setup working for both cloud +
      // self-hosted deployments.
      const endpoint = options.endpoint ?? deriveEndpoint(snap.batchUrl);
      const debug = (msg: string, ...rest: unknown[]) =>
        context.debug(`[pulse] ${msg}`, ...rest);
      const client = new PulseClient({ endpoint, apiKey: snap.apiKey });
      singleton = new PulseImpl(client, () => context.getSnapshot(), debug, options);
      return {
        async shutdown() {
          singleton?.dismiss();
          singleton = null;
        },
        onDistinctIdChange() {
          // Identity flipped — dismiss any in-flight survey so the
          // submit picks up the new identity. The host can re-show
          // when ready.
          singleton?.dismiss();
        },
      };
    },
  };
}

/** Host-side accessor. null when pulsePlugin() wasn't passed to init(). */
export function getPulse(): SankofaPulseAPI | null {
  return singleton;
}

/**
 * Strips the `/api/batch` suffix off the batchUrl so the pulse
 * client can prefix its own paths. Falls back to origin when the
 * batchUrl shape doesn't match expectations — defensive against
 * future browser-package URL renames.
 */
function deriveEndpoint(batchUrl: string): string {
  if (!batchUrl) return '';
  const idx = batchUrl.indexOf('/api/');
  if (idx >= 0) return batchUrl.slice(0, idx);
  try {
    const u = new URL(batchUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return batchUrl;
  }
}
