/**
 * Test leads: a pretend lead, handed to one agent, to try the whole flow -
 * the phone rings, the agent calls, picks a result, writes a note.
 *
 * It is a real row in `leads` (so every agent screen works on it unchanged)
 * flagged is_test, and that flag keeps it out of everything that matters:
 * no Meta events (the stage sweep and applyStageChange skip it), no 8X push or
 * mirror, no dashboard list, export, analytics or speed figure. It carries no
 * campaign, ad or ad account, which already keeps it out of most queries; the
 * flag covers the rest. The tick deletes it after three days.
 *
 * The answers are written in a real form's own words, so the agent sees what
 * a real lead looks like, not "field_1: test".
 */

import { supabaseAdmin } from "./supabase";
import { normalizeEgyptPhone, type FormQuestion } from "./meta";

type DB = ReturnType<typeof supabaseAdmin>;

/** Test leads older than this are deleted by the minute tick. */
export const TEST_LEAD_TTL_MS = 3 * 24 * 3600_000;
/** An agent can send themselves this many per hour. */
export const TEST_LEADS_PER_HOUR = 10;

const NAMES = ["Ahmed Hassan", "Mariam Adel", "Omar Khaled", "Nour El-Din", "Salma Youssef", "Karim Mostafa"];
const CONTACT_TYPES = /FULL_NAME|FIRST_NAME|LAST_NAME|PHONE|EMAIL|WHATSAPP/i;

export async function createTestLead(
  db: DB,
  agent: { id: string; name: string; phone?: string | null },
  opts: { phone?: string | null; by: "agent" | "admin" } = { by: "agent" }
): Promise<{ lead_id: string; full_name: string }> {
  // A recent form with real questions, for real wording.
  const { data: forms } = await db
    .from("lead_forms")
    .select("form_id,name,questions")
    .order("updated_at", { ascending: false })
    .limit(30);
  const form = ((forms ?? []) as { form_id: string; name: string | null; questions: FormQuestion[] | null }[]).find(
    (f) => (f.questions ?? []).filter((q) => !CONTACT_TYPES.test(q.type ?? "") && (q.options?.length ?? 0) > 0).length >= 2
  );

  const name = `TEST · ${NAMES[Math.floor(Math.random() * NAMES.length)]}`;
  const phone =
    normalizeEgyptPhone(opts.phone ?? undefined) ?? normalizeEgyptPhone(agent.phone ?? undefined) ?? "201000000000";

  const raw: Record<string, string> = { full_name: name, phone_number: `+${phone}` };
  for (const q of form?.questions ?? []) {
    if (CONTACT_TYPES.test(q.type ?? "")) continue;
    if (q.options?.length) raw[q.key] = q.options[Math.floor(Math.random() * q.options.length)].key;
    else raw[q.key] = q.label?.match(/ميزاني|budget|مقدم/i) ? "1,500,000" : "—";
  }
  if (!form) {
    raw.budget = "1,500,000";
    raw.unit_type = "Apartment";
    raw.payment_method = "Installments";
  }

  const now = new Date().toISOString();
  const leadId = `test_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { error } = await db.from("leads").insert({
    lead_id: leadId,
    is_test: true,
    full_name: name,
    phone,
    raw_fields: raw,
    form_id: form?.form_id ?? null,
    form_name: form?.name ?? null,
    campaign_name: "Test lead",
    platform: "test",
    submitted_at: now,
    agent_id: agent.id,
    assigned_at: now,
    owner: agent.name,
    status: "new",
  });
  if (error) throw new Error(error.message);

  await db.from("lead_notes").insert({
    lead_id: leadId,
    kind: "assign",
    body: agent.name,
    author: opts.by === "admin" ? "admin (test)" : "test",
  });
  return { lead_id: leadId, full_name: name };
}

export async function deleteTestLeads(db: DB, olderThanMs = 0): Promise<number> {
  let q = db.from("leads").delete().eq("is_test", true);
  if (olderThanMs > 0) q = q.lt("submitted_at", new Date(Date.now() - olderThanMs).toISOString());
  const { data, error } = await q.select("lead_id");
  if (error) return 0;
  return data?.length ?? 0;
}
