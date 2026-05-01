'use client';

/**
 * React surface over @sankofa/pulse.
 *
 * Three primitives:
 *
 *   1. usePulse() — returns the SankofaPulseAPI singleton, or null
 *      while Sankofa.init() is still resolving. Subscribes to a
 *      tick that flips when the plugin's setup runs, so React
 *      consumers re-render once the API becomes available.
 *
 *   2. usePulseEvent(event, listener) — subscribes to a single
 *      lifecycle event (survey_shown / dismissed / completed /
 *      partial_saved) and auto-unsubscribes on unmount or listener
 *      change. Internally wraps SankofaPulseAPI.on().
 *
 *   3. <SurveyModal surveyId open onComplete onDismiss /> —
 *      declarative survey rendering. When open flips true the
 *      hook calls show(); when it flips false the hook calls
 *      dismiss(). onComplete + onDismiss are stable callbacks
 *      bound to the corresponding lifecycle events for THIS
 *      survey only.
 *
 * # Why a tick rather than React context for the API
 *
 * The pulsePlugin singleton lives in @sankofa/pulse module scope.
 * Threading it through React context would require the host app
 * to call pulsePlugin() once at module load + then again inside
 * a Provider — easy footgun for the host. The tick approach lets
 * Sankofa.init() complete in any order relative to React render;
 * the moment the singleton is ready, the hook re-runs and sees it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPulse,
  type PulseEvent,
  type PulseEventListener,
  type PulseEventPayload,
  type PulseShowOptions,
  type SankofaPulseAPI,
} from '@sankofa/pulse';

// ── usePulse ────────────────────────────────────────────────────────

/**
 * Returns the SankofaPulseAPI when pulsePlugin's setup has run,
 * or null otherwise. Re-renders the consumer once the API
 * appears so a host can lazily call `pulse?.show(...)` after
 * Sankofa.init() resolves without orchestration ceremony.
 *
 * Polls every 50ms for up to 10 seconds while waiting. The poll
 * is harmless (cheap module-scope read) and stops the moment the
 * API resolves. After 10 seconds we stop polling — if init still
 * hasn't completed something else has gone wrong + the host's
 * console will already carry the cause.
 */
export function usePulse(): SankofaPulseAPI | null {
  const [api, setApi] = useState<SankofaPulseAPI | null>(() => getPulse());
  useEffect(() => {
    if (api) return;
    let cancelled = false;
    let elapsed = 0;
    const interval = window.setInterval(() => {
      if (cancelled) return;
      const next = getPulse();
      if (next) {
        setApi(next);
        window.clearInterval(interval);
        return;
      }
      elapsed += 50;
      if (elapsed > 10_000) window.clearInterval(interval);
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [api]);
  return api;
}

// ── usePulseEvent ───────────────────────────────────────────────────

/**
 * Subscribes to one Pulse lifecycle event. The listener is held
 * in a ref so React re-renders that change closure references
 * don't churn the underlying SankofaPulseAPI subscription —
 * SankofaPulseAPI.on() returns an unsubscribe handle, and we
 * only call it when the API itself or the event name changes.
 *
 * Pass listener=null to disable temporarily without unmounting.
 */
export function usePulseEvent(
  event: PulseEvent,
  listener: PulseEventListener | null,
): void {
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  }, [listener]);

  const api = usePulse();
  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.on(event, (payload) => {
      ref.current?.(payload);
    });
    return unsubscribe;
  }, [api, event]);
}

// ── <SurveyModal> ───────────────────────────────────────────────────

export interface SurveyModalProps {
  /** ID of the survey to show. Required. */
  surveyId: string;
  /**
   * Controlled open flag. Flipping false → true triggers show();
   * true → false triggers dismiss(). Re-mounting the component
   * with the same surveyId + open=true is idempotent (the second
   * show() is a no-op while one is already on screen).
   */
  open: boolean;
  /** Optional override of show() options (mount, context, respondent). */
  options?: PulseShowOptions;
  /** Fires when the respondent submits a final response. */
  onComplete?: (payload: PulseEventPayload) => void;
  /** Fires when the respondent (or host) dismisses without submitting. */
  onDismiss?: (payload: PulseEventPayload) => void;
  /** Fires on every save-partial roundtrip. Optional. */
  onPartialSaved?: (payload: PulseEventPayload) => void;
}

/**
 * Declarative wrapper around getPulse().show()/.dismiss(). The
 * component renders nothing (the modal lives in vanilla JS DOM
 * managed by SurveyRenderer); it exists purely to bind React
 * lifecycle to the imperative pulse API.
 *
 * Usage:
 *
 *   <SurveyModal
 *     surveyId="psv_post_purchase_csat"
 *     open={showCsat}
 *     options={{ context: { order_id: orderId } }}
 *     onComplete={() => setShowCsat(false)}
 *     onDismiss={() => setShowCsat(false)}
 *   />
 */
export function SurveyModal(props: SurveyModalProps): null {
  const api = usePulse();
  const lastOpenRef = useRef(false);
  const optsRef = useRef(props.options);
  optsRef.current = props.options;

  // Lifecycle event subscriptions filtered by survey_id so two
  // SurveyModals targeting different surveys don't cross-fire.
  usePulseEvent(
    'survey_completed',
    useCallback(
      (payload: PulseEventPayload) => {
        if (payload.survey_id === props.surveyId) {
          props.onComplete?.(payload);
        }
      },
      [props.surveyId, props.onComplete],
    ),
  );
  usePulseEvent(
    'survey_dismissed',
    useCallback(
      (payload: PulseEventPayload) => {
        if (payload.survey_id === props.surveyId) {
          props.onDismiss?.(payload);
        }
      },
      [props.surveyId, props.onDismiss],
    ),
  );
  usePulseEvent(
    'survey_partial_saved',
    useCallback(
      (payload: PulseEventPayload) => {
        if (payload.survey_id === props.surveyId) {
          props.onPartialSaved?.(payload);
        }
      },
      [props.surveyId, props.onPartialSaved],
    ),
  );

  useEffect(() => {
    if (!api) return;
    if (props.open && !lastOpenRef.current) {
      // false → true: show.
      void api.show(props.surveyId, optsRef.current);
      lastOpenRef.current = true;
    } else if (!props.open && lastOpenRef.current) {
      // true → false: dismiss.
      api.dismiss();
      lastOpenRef.current = false;
    }
  }, [api, props.open, props.surveyId]);

  // Cleanup: dismiss on unmount if we're still showing — host
  // shouldn't have a stale modal hanging around after a route
  // change.
  useEffect(() => {
    return () => {
      if (lastOpenRef.current && api) {
        api.dismiss();
      }
    };
  }, [api]);

  return null;
}

// ── Re-exports of the @sankofa/pulse public surface for ergonomics ─

export {
  pulsePlugin,
  getPulse,
  PulseClient,
  SurveyRenderer,
  SurveyState,
} from '@sankofa/pulse';

export type {
  Survey,
  SurveyKind,
  SurveyStatus,
  SurveyQuestion,
  QuestionKind,
  QuestionOption,
  QuestionValidation,
  SurveyTheme,
  TargetingRule,
  RuleKind,
  MatchOp,
  EligibilityContext,
  Decision,
  BranchingRule,
  BranchingActionKind,
  BranchingCondition,
  CondKind,
  CondOp,
  AnswerState,
  Outcome,
  SurveyBundle,
  SubmitPayload,
  PulseShowOptions,
  SankofaPulseAPI,
  PulseEvent,
  PulseEventListener,
  PulseEventPayload,
  PulsePluginOptions,
} from '@sankofa/pulse';
