/**
 * Lead quality score: 0-100, deterministic, explainable.
 *
 * Why it exists: Meta's Conversion Leads optimisation only knows which STAGE
 * each lead reached. Two "interested" leads look identical to it even when one
 * wrote a 12M budget in the form and answers on the first ring while the other
 * is a wrong number with no budget. The score folds what the form and the CRM
 * actually know into one number, and the CAPI events carry it as `value` - so
 * a campaign optimised for value learns to bring the expensive lead, not just
 * the curious one.
 *
 * Design rules, in order of importance:
 *   - DETERMINISTIC. Same lead, same score. No randomness, no model drift.
 *   - EXPLAINABLE. Every point traceable to a line here; scoreBreakdown()
 *     returns the pieces so a screen can show why.
 *   - STAGE-DOMINATED. The CRM's judgement outweighs any form heuristic:
 *     a disqualified lead scores near zero however rich the form looks.
 *
 * One deliberate exception on determinism: the touch-speed component reads the
 * clock for leads still untouched. A lead's score can therefore drift DOWN a
 * few points while it sits uncalled - which is exactly the signal it should
 * send. Recomputed on every sync, so the stored column follows.
 */

import { normalizeEgyptPhone } from "./meta";
import { rankOf, type Status } from "./stages";

/**
 * Where the CRM's verdict puts the floor and ceiling. Positive ranks climb to
 * 100 at reservation; the negative stages are worth almost nothing however
 * good the form data was - the CRM has already spoken.
 */
const STAGE_BASE: Record<Status, number> = {
  // The CRM's richer stage names (interested, low budget, call back...) are
  // already folded into these app statuses by lib/crm.ts before this runs.
  new: 10,
  no_answer: 5,
  contacted: 30,
  qualified: 55,
  meeting_booked: 70,
  meeting_done: 80,
  site_visit_booked: 85,
  site_visit_done: 88,
  eoi: 92,
  reservation: 100,
  disqualified: 0,
};

type RawFields = Record<string, unknown> | { name?: string; values?: unknown }[] | null | undefined;

/** Every string that appears anywhere in the form answers, key and value. */
function fieldPairs(raw: RawFields): { key: string; value: string }[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((f) => ({
        key: String((f as { name?: string }).name ?? ""),
        value: Array.isArray((f as { values?: unknown[] }).values)
          ? ((f as { values: unknown[] }).values || []).map(String).join(" ")
          : String((f as { values?: unknown }).values ?? ""),
      }))
      .filter((p) => p.key || p.value);
  }
  return Object.entries(raw).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? value.map(String).join(" ") : String(value ?? ""),
  }));
}

const BUDGET_KEY = /budget|price|ميزاني|سعر|مقدم|down[_ ]?payment/i;
const INTEREST_KEY = /interest|project|unit|type|location|مشروع|اهتم|وحدة|منطق|غرض/i;
const NON_ANSWERS = /^(no|none|لا|مفيش|-|n\/?a|\.+|\s*)$/i;

/**
 * The biggest number written in a budget-ish answer. Handles "3,000,000",
 * "3.5M", "من 2 لـ 4 مليون", machine keys like "3_000_000_-_5_000_000".
 */
export function parseBudgetEgp(text: string): number | null {
  if (!text) return null;
  const t = text.replace(/[,،]/g, "").replace(/_/g, "");
  let max = 0;
  const withUnit = t.matchAll(/(\d+(?:\.\d+)?)\s*(m|M|مليون|million|k|K|الف|ألف)?/g);
  for (const m of withUnit) {
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n === 0) continue;
    const unit = (m[2] || "").toLowerCase();
    if (unit === "m" || unit === "مليون" || unit === "million") n *= 1_000_000;
    else if (unit === "k" || unit === "الف" || unit === "ألف") n *= 1_000;
    // A bare small number in a budget answer almost always means millions
    // in this market ("من 3 ل 5" = 3-5M EGP).
    else if (n > 0 && n <= 50) n *= 1_000_000;
    if (n > max) max = n;
  }
  return max > 0 ? max : null;
}

export type QualityInput = {
  status: Status;
  submitted_at: string | null;
  status_at: string | null;
  raw_fields: RawFields;
  phone: string | null;
  email: string | null;
};

export type QualityBreakdown = {
  score: number;
  stage: number;
  budget: number;
  budgetEgp: number | null;
  interest: number;
  contact: number;
  touch: number;
};

export function scoreBreakdown(lead: QualityInput): QualityBreakdown {
  const stage = STAGE_BASE[lead.status] ?? 10;
  const negative = rankOf(lead.status) < 0;

  const pairs = fieldPairs(lead.raw_fields);

  // Budget: up to +15. Meaningless on a lead the CRM already rejected.
  let budgetEgp: number | null = null;
  for (const p of pairs) {
    if (!BUDGET_KEY.test(p.key) && !BUDGET_KEY.test(p.value)) continue;
    const n = parseBudgetEgp(p.value);
    if (n && (!budgetEgp || n > budgetEgp)) budgetEgp = n;
  }
  let budget = 0;
  if (budgetEgp && !negative) {
    if (budgetEgp >= 10_000_000) budget = 15;
    else if (budgetEgp >= 5_000_000) budget = 12;
    else if (budgetEgp >= 3_000_000) budget = 9;
    else if (budgetEgp >= 1_500_000) budget = 6;
    else budget = 3;
  }

  // A real answer to "what are you interested in": +5.
  const interest =
    !negative &&
    pairs.some((p) => INTEREST_KEY.test(p.key) && p.value.trim().length > 1 && !NON_ANSWERS.test(p.value.trim()))
      ? 5
      : 0;

  // Reachability: a phone that normalises to an Egyptian mobile +5, email +3.
  const contact = (normalizeEgyptPhone(lead.phone ?? undefined) ? 5 : 0) + (lead.email ? 3 : 0);

  // Touch speed. Touched fast is a good sign about the lead AND the process;
  // sitting uncalled for two days bleeds a few points until someone moves it.
  let touch = 0;
  const submitted = lead.submitted_at ? Date.parse(lead.submitted_at) : NaN;
  if (Number.isFinite(submitted)) {
    if (lead.status !== "new" && lead.status_at) {
      const hours = (Date.parse(lead.status_at) - submitted) / 3_600_000;
      if (hours >= 0 && hours <= 1) touch = 5;
      else if (hours >= 0 && hours <= 24) touch = 2;
    } else if (lead.status === "new" && Date.now() - submitted > 48 * 3_600_000) {
      touch = -5;
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(stage + budget + interest + contact + touch)));
  return { score, stage, budget, budgetEgp, interest, contact, touch };
}

export function leadQualityScore(lead: QualityInput): number {
  return scoreBreakdown(lead).score;
}
