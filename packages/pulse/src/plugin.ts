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

import { PulseClient, type PulseSurveySummary } from './client';
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
  /**
   * Host-side kill-switch for the auto-show pump. Per-survey
   * `auto_show` is the primary control — operators flip it from
   * the dashboard, the SDK respects it without a re-deploy. This
   * option is a hard "never auto-show ANYTHING in this host"
   * override, useful when the host wants to gate auto-show behind
   * its own consent / onboarding flow. Default: undefined (per-
   * survey settings drive behaviour).
   */
  autoShow?: boolean;
}

const DISMISS_STORAGE_PREFIX = 'sankofa.pulse.dismissed.';

class PulseImpl implements SankofaPulseAPI {
  private client: PulseClient;
  private snapshotFn: () => SankofaClientSnapshot;
  private debugFn: (msg: string, ...rest: unknown[]) => void;
  private opts: PulsePluginOptions;
  private listeners: Map<PulseEvent, Set<PulseEventListener>> = new Map();
  private active: SurveyRenderer | null = null;
  /** Most-recent survey summaries by id, populated by
   *  getActiveMatchingSurveys. The auto-show pump reads per-survey
   *  display fields (auto_show, cooldown, delay) from this map so
   *  dashboard edits propagate without re-fetching every tick. */
  private lastSummariesById: Map<string, PulseSurveySummary> = new Map();

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

  // ── Auto-show pump accessors ─────────────────────────────────────
  // The pump (defined in pulsePlugin().setup) needs a few inputs
  // from the plugin singleton: whether a survey is already on screen,
  // the current respondent id (for keyed dismiss storage), and the
  // configured cooldown. Exposing these as small read-only methods
  // keeps the pump separate from the api.ts surface (no public
  // export pollution) while avoiding tighter coupling via direct
  // field access.

  /** True when a survey modal is currently visible. */
  isActive(): boolean {
    return this.active !== null;
  }

  /** Best-effort respondent identifier — uses the current
   *  anonymousId from the host. Empty string if the SDK boot hasn't
   *  produced one yet (in which case the pump skips this tick). */
  respondentExternalId(): string {
    return this.snapshotFn().anonymousId ?? '';
  }

  /** Per-survey auto-show flag (dashboard-controlled). The pump
   *  uses this to skip surveys the operator wants to keep
   *  manual-only (e.g. a "Report a bug" form launched from a menu
   *  item). Defaults to true for older engines that don't yet ship
   *  this field. */
  surveyIsAutoShow(surveyId: string): boolean {
    const s = this.lastSummariesById.get(surveyId);
    if (!s) return true;
    if (typeof s.auto_show === 'boolean') return s.auto_show;
    return true;
  }

  /** Resolve a survey's per-id dismiss cooldown in ms. The dashboard
   *  publishes `display_cooldown_seconds` per survey on the list
   *  endpoint; the pump reads it via this accessor so the cooldown
   *  is the operator's choice, not a host config. Falls back to the
   *  legacy 7-day default for older engines that don't yet ship the
   *  field. */
  surveyDismissCooldownMs(surveyId: string): number {
    const s = this.lastSummariesById.get(surveyId);
    if (s && typeof s.display_cooldown_seconds === 'number') {
      return Math.max(0, s.display_cooldown_seconds * 1000);
    }
    return 7 * 24 * 60 * 60 * 1000;
  }

  /** Per-survey delay (ms) the pump waits after the trigger before
   *  presenting. Dashboard-controlled. 0 = immediate. */
  surveyDisplayDelayMs(surveyId: string): number {
    const s = this.lastSummariesById.get(surveyId);
    return s && typeof s.display_delay_ms === 'number'
      ? Math.max(0, s.display_delay_ms)
      : 0;
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
   * List every published survey the API key's project owns AND
   * whose targeting rules pass for the current respondent. Two
   * stages:
   *
   *   1. Server returns every published survey + its targeting
   *      rules (cheap projection — name, kind, rules; no questions).
   *   2. SDK runs the local targeting evaluator against each rule
   *      set using the same context the renderer would use.
   *
   * Splitting client/server eligibility this way lets the host UI
   * react instantly (no per-survey round-trip) while still keeping
   * sampling + frequency-cap math deterministic — both sides run
   * identical evaluators (mirrored from server/engine/ee/pulse/
   * targeting/evaluator.go).
   *
   * Returns the eligible Survey records as the caller would see in
   * a single bundle fetch. Network errors throw; an empty list
   * is a normal "no eligible surveys right now" result.
   */
  async getActiveMatchingSurveys(
    options: PulseShowOptions = {},
  ): Promise<Survey[]> {
    let summaries: PulseSurveySummary[];
    try {
      summaries = await this.client.listSurveys();
    } catch (err) {
      this.debugFn('getActiveMatchingSurveys: list failed', err);
      throw err;
    }
    // Refresh the per-survey lookup so the auto-show pump reads
    // current dashboard-controlled display fields without an
    // explicit re-fetch.
    this.lastSummariesById.clear();
    for (const s of summaries) this.lastSummariesById.set(s.id, s);

    const snap = this.snapshotFn();
    const externalId = options.respondent?.external_id ?? snap.anonymousId;
    const out: Survey[] = [];
    for (const s of summaries) {
      const decision = evaluateTargeting(
        s.targeting_rules,
        this.buildContext(s.id, externalId ?? '', options),
      );
      if (!decision.eligible) {
        this.debugFn(
          `getActiveMatchingSurveys: ${s.id} ineligible (${decision.reason})`,
        );
        continue;
      }
      // Cast to Survey — list summary is a strict subset of the
      // full Survey shape. Callers that need fields beyond what's
      // listed (questions, theme, branching) should call show() or
      // loadSurvey() per id.
      out.push({
        id: s.id,
        name: s.name,
        description: s.description ?? '',
        kind: s.kind,
        status: s.status,
        slug: s.slug,
      } as Survey);
    }
    return out;
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
          screen: this.resolveScreen(options),
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
    // Resolve the active screen for KindScreen targeting + for the
    // event-triggered survey path: when a survey fires because of a
    // Catch / analytics event, the screen the user is on at
    // trigger-time is the one we want to match against.
    const explicitScreen = (ctx as Record<string, unknown>).screenName;
    const snap = this.snapshotFn();
    const screenName =
      typeof explicitScreen === 'string' && explicitScreen.length > 0
        ? explicitScreen
        : snap.currentScreen && snap.currentScreen !== 'Unknown'
        ? snap.currentScreen
        : typeof window !== 'undefined'
        ? window.location.pathname
        : undefined;
    return {
      surveyId,
      respondentExternalId: externalId,
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
      screenName,
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

  /**
   * Resolve the active screen at submit time. Precedence (per the
   * cross-product screen-tagging contract): explicit
   * `options.context.screenName` > host's tracked currentScreen >
   * auto-detected `location.pathname`. Returning undefined leaves
   * the wire field unset; the server preserves "unknown" rather
   * than inventing a value.
   */
  private resolveScreen(options: PulseShowOptions): string | undefined {
    const explicit = (options.context as Record<string, unknown> | undefined)?.screenName;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const snap = this.snapshotFn();
    if (snap.currentScreen && snap.currentScreen !== 'Unknown') return snap.currentScreen;
    if (typeof window !== 'undefined' && window.location?.pathname) return window.location.pathname;
    return undefined;
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

      // Auto-show pump: in production hosts the operator expects a
      // newly-published survey to "just appear" — they shouldn't
      // have to wire show() per route. We start a pump that calls
      // getActiveMatchingSurveys + show() once at boot, then again
      // on every SPA navigation (popstate + history pushState/
      // replaceState patches). Default ON; opt out via
      // pulsePlugin({ autoShow: false }).
      const pump =
        options.autoShow !== false && typeof window !== 'undefined'
          ? startAutoShowPump(singleton, debug)
          : null;
      return {
        async shutdown() {
          pump?.stop();
          singleton?.dismiss();
          singleton = null;
        },
        checkIntegration() {
          const missing: string[] = [];
          const warnings: string[] = [];
          if (!singleton) {
            missing.push(
              "Pulse plugin returned no instance — setup() failed silently. Check that pulsePlugin() is included in Sankofa.init({ plugins: [...] }).",
            );
          }
          if (!snap.apiKey) {
            missing.push(
              "No API key reached the Pulse plugin — Sankofa.init() may not have resolved before plugin setup.",
            );
          }
          if (typeof window === "undefined") {
            warnings.push(
              "Running outside a browser context — Pulse surveys cannot render.",
            );
          }
          return {
            module: "pulse",
            level: missing.length === 0 ? "full" : missing.length >= 2 ? "broken" : "partial",
            missing,
            warnings,
          };
        },
        onDistinctIdChange() {
          // Identity flipped — dismiss any in-flight survey so the
          // submit picks up the new identity. The host can re-show
          // when ready. Re-evaluate auto-show under the new id.
          singleton?.dismiss();
          pump?.tick();
        },
      };
    },
  };
}

/** Auto-show pump handle. Holding a reference lets the plugin's
 *  shutdown hook detach the navigation listeners — important in
 *  hot-reload + test environments where multiple plugin instances
 *  would otherwise stack listeners on `window`. */
interface AutoShowPump {
  /** Manually re-evaluate (e.g. after identify()). */
  tick(): void;
  /** Detach listeners + cancel any pending tick. */
  stop(): void;
}

function startAutoShowPump(
  pulse: PulseImpl,
  debug: (msg: string, ...rest: unknown[]) => void,
): AutoShowPump {
  let stopped = false;
  let pending: number | null = null;

  // Run on the next microtask so the host's init() resolves before
  // we make any network calls — keeps the boot waterfall predictable.
  const schedule = () => {
    if (stopped) return;
    if (pending !== null) return;
    pending = window.setTimeout(() => {
      pending = null;
      void runOnce();
    }, 0);
  };

  const runOnce = async () => {
    if (stopped) return;
    try {
      const surveys = await pulse.getActiveMatchingSurveys();
      if (stopped || surveys.length === 0) return;
      const respondentId = pulse.respondentExternalId();
      // Per-survey auto_show is the dashboard-controlled gate. The
      // pump skips surveys flagged auto_show: false even if they
      // pass targeting — those are explicit `show(id)` only.
      const candidate = surveys.find((s) => {
        if (!pulse.surveyIsAutoShow(s.id)) return false;
        const cooldownMs = pulse.surveyDismissCooldownMs(s.id);
        return !isRecentlyDismissed(s.id, respondentId, cooldownMs);
      });
      if (!candidate) {
        debug('autoShow: nothing eligible this tick');
        return;
      }
      // Race-guard: if another show is in-flight (the pump can fire
      // twice quickly during a fast SPA route swap), skip rather
      // than stack modals. PulseImpl already guards internally; this
      // is just a clearer log.
      if (pulse.isActive()) return;
      const delay = pulse.surveyDisplayDelayMs(candidate.id);
      if (delay > 0) {
        debug(`autoShow: deferring ${candidate.id} by ${delay}ms`);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (stopped || pulse.isActive()) return;
      }
      debug(`autoShow: presenting ${candidate.id}`);
      await pulse.show(candidate.id);
    } catch (err) {
      debug('autoShow tick failed', err);
    }
  };

  // SPA navigation: history API doesn't fire popstate on
  // pushState/replaceState, so monkey-patch them. Restore on stop()
  // so a second plugin instance (HMR, test) doesn't double-wrap.
  // Typed loosely because history's signature uses optional + nullable
  // strings that don't fit the standard generic-function shape.
  type HistoryFn = typeof window.history.pushState;
  const origPush: HistoryFn = window.history.pushState.bind(window.history);
  const origReplace: HistoryFn = window.history.replaceState.bind(window.history);
  window.history.pushState = function patchedPush(...args: Parameters<HistoryFn>) {
    origPush(...args);
    schedule();
  };
  window.history.replaceState = function patchedReplace(...args: Parameters<HistoryFn>) {
    origReplace(...args);
    schedule();
  };
  const onPopState = () => schedule();
  window.addEventListener('popstate', onPopState);

  // Initial fire — covers hard-refresh + first paint.
  schedule();

  // The "shown" event also clears any stale dismiss entries for the
  // same survey id; the "dismissed" / "completed" events stamp the
  // dismiss store so the user isn't re-prompted on the next nav.
  const offShown = pulse.on('survey_shown', (payload) => {
    clearDismiss(payload.survey_id, pulse.respondentExternalId());
  });
  const offDismissed = pulse.on('survey_dismissed', (payload) => {
    stampDismiss(payload.survey_id, pulse.respondentExternalId());
  });
  const offCompleted = pulse.on('survey_completed', (payload) => {
    stampDismiss(payload.survey_id, pulse.respondentExternalId());
  });

  return {
    tick: schedule,
    stop() {
      stopped = true;
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
      }
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
      window.removeEventListener('popstate', onPopState);
      offShown();
      offDismissed();
      offCompleted();
    },
  };
}

// ── localStorage dismiss store ───────────────────────────────────────
//
// Keyed per (respondent, survey) so two users sharing a browser don't
// suppress each other. The cooldown is configurable per plugin
// instance; default is 7 days.

function dismissKey(surveyId: string, respondentId: string): string {
  return `${DISMISS_STORAGE_PREFIX}${respondentId}.${surveyId}`;
}

function isRecentlyDismissed(
  surveyId: string,
  respondentId: string,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0) return false;
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(dismissKey(surveyId, respondentId));
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < cooldownMs;
  } catch {
    return false;
  }
}

function stampDismiss(surveyId: string, respondentId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(dismissKey(surveyId, respondentId), String(Date.now()));
  } catch {
    // Quota / private mode — silently swallow. Worst case the
    // user sees the survey again on next nav; the server-side
    // frequency_cap rule still gates real responses.
  }
}

function clearDismiss(surveyId: string, respondentId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(dismissKey(surveyId, respondentId));
  } catch {
    // ignore
  }
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
