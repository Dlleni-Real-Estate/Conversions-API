import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { chainFor, isStatus, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { sendLeadEvents } from "@/lib/capi";
import { activeAccounts } from "@/lib/accounts";
import { APP_SENDS_EVENTS, SENDER } from "@/lib/sender";

export const dynamic = "force-dynamic";

/**
 * The sales team moves a lead → we store it → we log it → we tell Meta.
 * Body: { lead_id, status, note?, owner?, deal_value? }
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The dashboard is read-only, and when the CRM owns the Meta conversation
  // this endpoint must refuse rather than quietly double-send.
  if (!APP_SENDS_EVENTS) {
    return NextResponse.json(
      { error: `stages are set in 8X CRM (CAPI_SENDER=${SENDER})` },
      { status: 409 }
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.lead_id || !body?.status) {
    return NextResponse.json({ error: "lead_id and status are required" }, { status: 400 });
  }
  const status = String(body.status);
  if (!isStatus(status)) {
    return NextResponse.json({ error: `unknown status "${status}"` }, { status: 400 });
  }

  const db = supabaseAdmin();
  const stage = STAGE_BY_STATUS[status];

  // Read the old status first so the timeline entry can say where it came from.
  const { data: before } = await db
    .from("leads")
    .select("status")
    .eq("lead_id", body.lead_id)
    .maybeSingle();

  const { data: lead, error } = await db
    .from("leads")
    .update({
      status,
      owner: body.owner ?? undefined,
      deal_value: body.deal_value ?? undefined,
      status_at: new Date().toISOString(),
    })
    .eq("lead_id", body.lead_id)
    .select("lead_id, phone, email, deal_value, status, ad_account_id")
    .single();

  if (error || !lead) {
    return NextResponse.json({ error: error?.message || "lead not found" }, { status: 404 });
  }

  // Every move is written into the same stream the notes live in, so a lead's
  // history reads as one story instead of a status plus a mystery.
  await db.from("lead_notes").insert({
    lead_id: lead.lead_id,
    kind: "stage",
    from_status: before?.status ?? null,
    to_status: status,
    body: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null,
    author: body.owner ?? null,
  });

  if (!stage.event) {
    return NextResponse.json({ ok: true, lead, capi: { skipped: "no event for this status" } });
  }

  // Meta counts a lead as having reached a stage only if we sent THAT stage's
  // event. A broker who drags a lead straight from New to "Site visit done"
  // would otherwise leave Meta believing the lead was never qualified — and
  // Qualified is the stage the campaign optimises for. So a move to rank N
  // sends every positive stage from 1 to N. Meta asks for exactly this on the
  // CRM card in Events Manager: "For best results, send all existing events."
  //
  // Re-sending a stage the lead already passed is free: the event_id is
  // deterministic, so Meta discards the repeat instead of counting it twice.
  const chain = chainFor(status as Status);

  // Route through the account that produced this lead. If that account is
  // disconnected, paused or unverified, refuse rather than fall back to some
  // other account's dataset - Meta accepts that with a 200 and attributes it
  // to nothing, which cannot be caught after the fact.
  const { scopes } = await activeAccounts(db);
  const scope = lead.ad_account_id
    ? scopes.find((s) => s.adAccountId === lead.ad_account_id)
    : undefined;
  if (lead.ad_account_id && !scope) {
    return NextResponse.json(
      {
        error:
          `ad account ${lead.ad_account_id} is not active (disconnected, paused, or unverified) - ` +
          `reconnect it in Settings before sending feedback for its leads`,
      },
      { status: 409 }
    );
  }

  // Ordered timestamps ending now, so the sequence Meta reads is the sequence
  // the lead actually walked, and every one of them sits after the lead's
  // creation time (Meta discards an event stamped before its lead existed).
  const now = Date.now();
  const result = await sendLeadEvents(
    chain.map((st, i) => ({
      leadId: lead.lead_id,
      eventName: st.event as string,
      eventTime: new Date(now - (chain.length - 1 - i) * 1000),
      phone: lead.phone ?? undefined,
      email: lead.email ?? undefined,
      value: st.status === "reservation" ? (body.deal_value ?? lead.deal_value ?? null) : null,
    })),
    100,
    scope?.datasetId,
    scope?.token
  );

  return NextResponse.json({
    ok: true,
    lead,
    event: stage.event,
    events: chain.map((st) => st.event),
    capi: {
      ok: result.failed === 0,
      ...result,
      error: result.failed > 0 ? `${result.failed}/${result.attempted} rejected` : undefined,
    },
  });
}
