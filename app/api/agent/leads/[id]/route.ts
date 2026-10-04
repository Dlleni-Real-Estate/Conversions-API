import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest, type Agent } from "@/lib/agents";
import { AGENT_LEAD_COLUMNS, CLOSED_STATUSES, dictionaryFor, type AgentLeadRow } from "@/lib/agentLeads";
import { ACTIONABLE, isStatus, type Status } from "@/lib/stages";
import { applyStageChange } from "@/lib/outcome";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
type DB = ReturnType<typeof supabaseAdmin>;

/** The lead, only if it is this agent's. Anyone else's lead does not exist. */
async function ownLead(db: DB, agent: Agent, leadId: string): Promise<AgentLeadRow | null> {
  const { data } = await db
    .from("leads")
    .select(AGENT_LEAD_COLUMNS)
    .eq("lead_id", leadId)
    .eq("agent_id", agent.id)
    .maybeSingle();
  return (data as unknown as AgentLeadRow) ?? null;
}

async function timeline(db: DB, leadId: string) {
  const { data } = await db
    .from("lead_notes")
    .select("id, kind, body, from_status, to_status, author, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(100);
  return data ?? [];
}

/** GET -> { lead, notes, dictionary } */
export async function GET(req: NextRequest, ctx: Ctx) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const lead = await ownLead(db, agent, id);
  if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    lead,
    notes: await timeline(db, id),
    dictionary: await dictionaryFor(db, [lead.form_id]),
  });
}

/**
 * POST { action, ... }
 *
 *   open                       the agent opened the alert; ringing stops
 *   call { channel }           a call (or WhatsApp) was started from the app
 *   outcome { status, note?, follow_up_at?, deal_value? }
 *                              what happened on the call
 *   note { body }              a note on its own
 *   snooze { minutes }         move the follow-up this many minutes from now
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const lead = await ownLead(db, agent, id);
  if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const action = String(body?.action || "");
  const now = new Date().toISOString();

  if (action === "open") {
    if (!lead.acked_at) await db.from("leads").update({ acked_at: now }).eq("lead_id", id);
    return NextResponse.json({ ok: true });
  }

  if (action === "call") {
    const channel = body?.channel === "whatsapp" ? "whatsapp" : "phone";
    await db
      .from("leads")
      .update({
        acked_at: lead.acked_at ?? now,
        first_call_at: lead.first_call_at ?? now,
        last_call_at: now,
        call_count: Number(lead.call_count ?? 0) + 1,
      })
      .eq("lead_id", id);
    await db.from("lead_notes").insert({ lead_id: id, kind: "call", body: channel, author: agent.name });
    return NextResponse.json({ ok: true });
  }

  // "Remind me in 10 min" on a callback ring: the follow-up moves, so the
  // list, the phone's next alarm and any other phone all agree.
  if (action === "snooze") {
    const minutes = Math.round(Number(body?.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      return NextResponse.json({ ok: false, error: "minutes must be 1-1440" }, { status: 400 });
    }
    const at = new Date(Date.now() + minutes * 60_000).toISOString();
    await db.from("leads").update({ follow_up_at: at }).eq("lead_id", id);
    return NextResponse.json({ ok: true, follow_up_at: at });
  }

  if (action === "note") {
    const text = typeof body?.body === "string" ? body.body.trim().slice(0, 4000) : "";
    if (!text) return NextResponse.json({ ok: false, error: "empty note" }, { status: 400 });
    await db.from("lead_notes").insert({ lead_id: id, kind: "note", body: text, author: agent.name });
    await db.from("leads").update({ notes: text }).eq("lead_id", id);
    return NextResponse.json({ ok: true, notes: await timeline(db, id) });
  }

  if (action === "outcome") {
    const status = String(body?.status || "");
    if (!isStatus(status) || !ACTIONABLE.includes(status as Status)) {
      return NextResponse.json({ ok: false, error: `unknown status "${status}"` }, { status: 400 });
    }
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 4000) : "";
    const dealValue = Number.isFinite(Number(body?.deal_value)) && Number(body?.deal_value) > 0 ? Number(body.deal_value) : null;

    let followUp: string | null | undefined = undefined;          // undefined = leave as is
    if (body?.follow_up_at === null) followUp = null;
    else if (typeof body?.follow_up_at === "string" && Number.isFinite(Date.parse(body.follow_up_at))) {
      followUp = new Date(body.follow_up_at).toISOString();
    }
    if (CLOSED_STATUSES.includes(status)) followUp = null;

    let capi: Record<string, unknown> | undefined;
    if (status !== lead.status) {
      const res = await applyStageChange(db, {
        leadId: id,
        status: status as Status,
        note: note || null,
        author: agent.name,
        dealValue,
      });
      // 409 = the stage is saved but its ad account is disconnected, so the
      // Meta events wait. That is not the agent's problem to solve.
      if (!res.ok && res.status !== 409) {
        return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
      }
      capi = res.ok ? res.capi : { held: res.error };
    } else if (note) {
      // Same stage again - a second unanswered call, say. The note is the news.
      await db.from("lead_notes").insert({ lead_id: id, kind: "note", body: note, author: agent.name });
    }

    await db
      .from("leads")
      .update({
        acked_at: lead.acked_at ?? now,
        ...(followUp !== undefined ? { follow_up_at: followUp } : {}),
        ...(note ? { notes: note } : {}),
        ...(dealValue && status === lead.status ? { deal_value: dealValue } : {}),
      })
      .eq("lead_id", id);

    return NextResponse.json({
      ok: true,
      lead: await ownLead(db, agent, id),
      notes: await timeline(db, id),
      capi,
    });
  }

  return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
}
