import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { isStatus } from "@/lib/stages";
import { isAdmin } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { APP_SENDS_EVENTS, SENDER } from "@/lib/sender";
import { applyStageChange } from "@/lib/outcome";

export const dynamic = "force-dynamic";

/**
 * The sales team moves a lead → we store it → we log it → we tell Meta.
 * Body: { lead_id, status, note?, owner?, deal_value? }
 *
 * The move itself is lib/outcome.ts, shared with the agent app's call outcome.
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });

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

  const result = await applyStageChange(supabaseAdmin(), {
    leadId: String(body.lead_id),
    status,
    note: body.note ?? null,
    owner: body.owner ?? null,
    dealValue: body.deal_value ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await logAudit(req, "stage_change", String(body.lead_id), { from: result.from, to: status });

  return NextResponse.json({
    ok: true,
    lead: result.lead,
    event: result.event,
    events: result.events,
    capi: result.capi,
  });
}
