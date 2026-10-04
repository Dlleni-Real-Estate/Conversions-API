/**
 * The lead as an agent's phone sees it: the agent's own leads only, with the
 * form in its own words.
 */

import { supabaseAdmin } from "./supabase";
import { answerLabel, buildDictionary, questionLabel, type FormDictionary } from "./labels";
import type { FormSchema } from "./meta";

type DB = ReturnType<typeof supabaseAdmin>;

export const AGENT_LEAD_COLUMNS =
  "lead_id,full_name,phone,email,status,status_at,submitted_at,campaign_id,campaign_name,adset_name,ad_name," +
  "form_id,form_name,platform,raw_fields,notes,deal_value,agent_id,assigned_at,acked_at,first_call_at," +
  "last_call_at,call_count,follow_up_at,is_test";

/** Stages after which nobody needs to be reminded to call again. */
export const CLOSED_STATUSES = ["disqualified", "reservation"];

export type AgentLeadRow = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  status: string;
  campaign_name: string | null;
  form_id: string | null;
  raw_fields: Record<string, string> | null;
  assigned_at: string | null;
  [k: string]: unknown;
};

/** The wording of just the forms these leads came from. */
export async function dictionaryFor(db: DB, formIds: (string | null | undefined)[]): Promise<FormDictionary> {
  const ids = [...new Set(formIds.filter((v): v is string => Boolean(v)))];
  if (ids.length === 0) return buildDictionary([]);
  const { data } = await db.from("lead_forms").select("form_id, name, locale, questions").in("form_id", ids);
  return buildDictionary((data ?? []) as unknown as FormSchema[]);
}

const CONTACT_KEY = /name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i;

/** The first answers worth reading before dialling - not the name or number again. */
export function previewAnswers(
  dict: FormDictionary,
  raw: Record<string, string> | null | undefined,
  n = 2
): { q: string; a: string }[] {
  return Object.entries(raw || {})
    .filter(([k, v]) => !CONTACT_KEY.test(k) && String(v ?? "").trim())
    .slice(0, n)
    .map(([k, v]) => ({ q: questionLabel(dict, k), a: answerLabel(dict, k, String(v)) }));
}
