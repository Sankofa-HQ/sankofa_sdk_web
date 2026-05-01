/**
 * Translation helpers — wire-shape lookups + locale resolution.
 *
 * The renderer never reads bundle.translations directly. It
 * builds a Translator (resolveLocale + lookup helpers) once per
 * mount and threads that through render passes. Keeps the lookup
 * logic in one place + lets the dashboard reuse the same shape
 * for translation editor previews.
 */

import type {
  Survey,
  SurveyBundle,
  SurveyQuestion,
  QuestionOption,
  TranslationStrings,
} from './types';

/**
 * Resolve which locale the renderer should use given the host's
 * preference, the bundle's available locales, and the runtime
 * default. Resolution order:
 *
 *   1. Exact match against bundle.translations keys
 *   2. Language-only fallback (en-US → en) against bundle.translations
 *   3. (No match) → render source strings unchanged
 *
 * Returns null when no translation should be applied.
 */
export function resolveLocale(
  bundle: SurveyBundle,
  preferred?: string,
): string | null {
  const translations = bundle.translations;
  if (!translations) return null;
  const candidates = [
    preferred,
    typeof navigator !== 'undefined' ? navigator.language : '',
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (translations[candidate]) return candidate;
    const language = candidate.split('-')[0];
    if (translations[language]) return language;
  }
  return null;
}

/**
 * Translator wraps a single locale's string set + a lookup API.
 * Returns null when no locale was resolved — the renderer treats
 * a null translator as a no-op.
 */
export class Translator {
  private strings: TranslationStrings;

  constructor(strings: TranslationStrings) {
    this.strings = strings;
  }

  surveyName(survey: Survey): string {
    return this.strings['survey.name'] ?? survey.name;
  }

  surveyDescription(survey: Survey): string | undefined {
    return this.strings['survey.description'] ?? survey.description;
  }

  questionPrompt(question: SurveyQuestion): string {
    return this.strings[`question.${question.id}.prompt`] ?? question.prompt;
  }

  questionHelptext(question: SurveyQuestion): string | undefined {
    return (
      this.strings[`question.${question.id}.helptext`] ?? question.helptext
    );
  }

  optionLabel(question: SurveyQuestion, option: QuestionOption): string {
    return (
      this.strings[`question.${question.id}.option.${option.key}.label`] ??
      option.label
    );
  }
}

/**
 * Convenience factory — pulls the translator for the resolved
 * locale, or null when no translation applies.
 */
export function buildTranslator(
  bundle: SurveyBundle,
  preferred?: string,
): Translator | null {
  const locale = resolveLocale(bundle, preferred);
  if (!locale) return null;
  const strings = bundle.translations?.[locale];
  if (!strings) return null;
  return new Translator(strings);
}
