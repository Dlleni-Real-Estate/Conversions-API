/**
 * Turning Meta's machine keys back into the words the customer actually read.
 *
 * A lead arrives as { payment_method: "still_exploring" }. The form definition
 * says that question was "تحب تدفع إزاي؟" and that answer was "لسه بستكشف وبسأل".
 * Nothing here translates anything — it looks the wording up and shows it
 * verbatim, in whatever language the form was written in.
 */

import type { FormQuestion, FormSchema } from "./meta";

export type FormDictionary = {
  /** question key → the question as written on the form */
  question: Record<string, string>;
  /** question key → { answer key → the answer as written on the form } */
  answer: Record<string, Record<string, string>>;
};

export function buildDictionary(forms: FormSchema[]): FormDictionary {
  const question: Record<string, string> = {};
  const answer: Record<string, Record<string, string>> = {};

  for (const form of forms) {
    for (const q of (form.questions || []) as FormQuestion[]) {
      // First form wins for a shared key — they are the same question across
      // variants of the same campaign, and the first is the one in use.
      if (q.label && !question[q.key]) question[q.key] = q.label;
      if (q.options?.length) {
        const map = answer[q.key] ?? {};
        for (const o of q.options) if (o.value && !map[o.key]) map[o.key] = o.value;
        answer[q.key] = map;
      }
    }
  }

  return { question, answer };
}

/** Fall back to a readable version of the key when the form is unknown. */
const humanise = (key: string) => key.replace(/[_-]+/g, " ").trim();

export function questionLabel(dict: FormDictionary | null, key: string): string {
  return dict?.question[key] || humanise(key);
}

export function answerLabel(dict: FormDictionary | null, key: string, value: string): string {
  // Multi-select answers come back comma-joined; resolve each part.
  return value
    .split(", ")
    .map((v) => dict?.answer[key]?.[v] || humanise(v))
    .join("، ");
}
