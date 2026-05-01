'use client';

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";
import { Sankofa, type SankofaInitOptions } from "@sankofa/browser";

const SankofaContext = createContext(Sankofa);

export function SankofaProvider(props: {
  children: ReactNode;
  options: SankofaInitOptions;
  shutdownOnUnmount?: boolean;
}) {
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void Sankofa.init(props.options);
    }

    return () => {
      if (props.shutdownOnUnmount) {
        void Sankofa.shutdown();
      }
    };
  }, [props.options, props.shutdownOnUnmount]);

  return (
    <SankofaContext.Provider value={Sankofa}>
      {props.children}
    </SankofaContext.Provider>
  );
}

export function useSankofa() {
  return useContext(SankofaContext);
}

export { Sankofa };
export type { SankofaInitOptions } from "@sankofa/browser";

// Pulse surface — hooks + declarative modal for surveys. Re-exports
// the @sankofa/pulse types so a host app only depends on
// @sankofa/react when they pick the React adapter.
export {
  usePulse,
  usePulseEvent,
  SurveyModal,
  pulsePlugin,
  getPulse,
  PulseClient,
  SurveyRenderer,
  SurveyState,
} from './pulse';

export type {
  SurveyModalProps,
} from './pulse';

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
} from './pulse';
