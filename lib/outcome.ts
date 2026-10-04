/**
 * A lead moves to a stage: store it, write it into the timeline, reprice it,
 * and tell Meta. Defined ONCE, for the two places a stage is set by hand -
 * the dashboard's /api/feedback and the agent app's call outcome - because two
 * copies of "what a stage move sends" is exactly how the chain bug shipped.
 */

import { supabaseAdmin } from "./supabase";
import { chainFor, STAGE_BY_STATUS, type Status } from "./stages";
import { sendLeadEvents } from "./capi";
import { activeAccounts } from "./accounts";
import { leadQualityScore } from "./quality";
import { APP_SENDS_EVENTS } from "./sender";

type DB = ReturnType<typeof supabaseAdmin>;

export type StageChange = {
  leadId: string;
  status: Status;
  note?: string | null;
  /** Who made the move - written on the timeline entry. */
  author?: string | null;
  /** Dashboard only: the old route let the caller rename the owner. */
  owner?: string | null;
  dealValue?: number | null;
};

export type StageResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      lead: Record<string, unknown>;
      from: Status | null;
      event: string | null;
      events: string[];
      capi: Record<string, unknown>;
    };

const LEAD_RETURN =
  "lead_id, phone, email, deal_value, status, ad_account_id, submitted_at, status_at, raw_fields";

export async function applyStageChange(db: DB, change: StageChange): Promise<StageResult> {
  const stage = STAGE_BY_STATUS[change.status];
  const note = typeof change.note === "string" && change.note.trim() ? change.note.trim() : null;

  // Read the old status first so the timeline entry can say where it came from.
  const { data: before } = await db
    .from("leads")
    .select("status")
    .eq("lead_id", change.leadId)
    .maybeSingle();

  const { data: lead, error } = await db
    .from("leads")
    .update({
      status: change.status,
      owner: change.owner ?? undefined,
      deal_value: change.dealValue ?? undefined,
      status_at: new Date().toISOString(),
    })
    .eq("lead_id", change.leadId)
    .select(LEAD_RETURN)
    .single();

  if (error || !lead) return { ok: false, status: 404, error: error?.message || "lead not found" };

  // Every move is written into the same stream the notes live in, so a lead's
  // history reads as one story instead of a status plus a mystery.
  await db.from("lead_notes").insert({
    lead_id: lead.lead_id,
    kind: "stage",
    from_status: before?.status ?? null,
    to_status: change.status,
    body: note,
    author: change.author ?? change.owner ?? null,
  });

  const from = (before?.status as Status | undefined) ?? null;
  if (!stage.event) {
    return { ok: true, lead, from, event: null, events: [], capi: { skipped: "no event for this status" } };
  }

  const score = leadQualityScore({
    status: lead.status as Status,
    submitted_at: lead.submitted_at ?? null,
    status_at: lead.status_at ?? null,
    raw_fields: lead.raw_fields ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
  });
  await db.from("leads").update({ quality_score: score }).eq("lead_id", lead.lead_id);

  // Meta counts a lead as having reached a stage only if we sent THAT stage's
  // event, so a move to rank N sends every positive stage from 1 to N (see
  // chainFor). Re-sending a stage already passed is free: the event_id is
  // deterministic and Meta discards the repeat.
  const chain = chainFor(change.status);
  const events = chain.map((st) => st.event as string);

  // Someone else owns the conversation with Meta. The stage is still the
  // lead's stage; it just is not ours to send.
  if (!APP_SENDS_EVENTS) {
    return { ok: true, lead, from, event: stage.event, events, capi: { skipped: "CAPI_SENDER is not app" } };
  }

  // Route through the account that produced this lead. If that account is
  // disconnected, paused or unverified, hold the events rather than fall back
  // to another account's dataset - Meta accepts that with a 200 and
  // attributes it to nothing. The stage itself is already saved.
  const { scopes } = await activeAccounts(db);
  const scope = lead.ad_account_id ? scopes.find((s) => s.adAccountId === lead.ad_account_id) : undefined;
  if (lead.ad_account_id && !scope) {
    return {
      ok: false,
      status: 409,
      error:
        `ad account ${lead.ad_account_id} is not active (disconnected, paused, or unverified) - ` +
        `reconnect it in Settings before sending feedback for its leads`,
    };
  }

  // Ordered timestamps ending now, so the sequence Meta reads is the sequence
  // the lead actually walked, and every one sits after the lead's creation.
  const now = Date.now();
  const result = await sendLeadEvents(
    chain.map((st, i) => ({
      leadId: lead.lead_id,
      eventName: st.event as string,
      eventTime: new Date(now - (chain.length - 1 - i) * 1000),
      phone: lead.phone ?? undefined,
      email: lead.email ?? undefined,
      value: st.status === "reservation" ? (change.dealValue ?? lead.deal_value ?? null) : score,
      qualityScore: score,
    })),
    100,
    scope?.datasetId,
    scope?.token
  );

  return {
    ok: true,
    lead,
    from,
    event: stage.event,
    events,
    capi: {
      ok: result.failed === 0,
      ...result,
      error: result.failed > 0 ? `${result.failed}/${result.attempted} rejected` : undefined,
    },
  };
}
