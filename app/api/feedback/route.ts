import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { STAGE_BY_STATUS, isStatus } from "@/lib/stages";
import { sendLeadEvent } from "@/lib/capi";

export const dynamic = "force-dynamic";

/**
 * The sales team sets a status → we store it → we tell Meta.
 * Body: { lead_id, status, notes?, owner?, deal_value? }
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  const { data: lead, error } = await db
    .from("leads")
    .update({
      status,
      notes: body.notes ?? undefined,
      owner: body.owner ?? undefined,
      deal_value: body.deal_value ?? undefined,
      status_at: new Date().toISOString(),
    })
    .eq("lead_id", body.lead_id)
    .select("lead_id, phone, email, deal_value, status")
    .single();

  if (error || !lead) {
    return NextResponse.json({ error: error?.message || "lead not found" }, { status: 404 });
  }

  // "new" carries no signal — Meta already fired Lead on submit.
  if (!stage.event) {
    return NextResponse.json({ ok: true, lead, capi: { skipped: "no event for this status" } });
  }

  const result = await sendLeadEvent({
    leadId: lead.lead_id,
    eventName: stage.event,
    phone: lead.phone ?? undefined,
    email: lead.email ?? undefined,
    value: status === "won" ? (body.deal_value ?? lead.deal_value ?? null) : null,
  });

  return NextResponse.json({ ok: true, lead, event: stage.event, capi: result });
}
