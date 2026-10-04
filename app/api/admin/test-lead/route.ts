import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createTestLead, deleteTestLeads } from "@/lib/testLeads";

export const dynamic = "force-dynamic";

/**
 * POST, one of:
 *   { agent_id, phone?, count? }   send 1-5 test leads to an agent; their phone rings
 *   { action: "clear" }            delete every test lead now
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });
  const db = supabaseAdmin();
  const body = await req.json().catch(() => null);

  if (body?.action === "clear") {
    const deleted = await deleteTestLeads(db);
    await logAudit(req, "test_leads_clear", null, { deleted });
    return NextResponse.json({ ok: true, deleted });
  }

  const { data: agent } = await db.from("agents").select("id,name,phone,active").eq("id", String(body?.agent_id || "")).maybeSingle();
  if (!agent || !agent.active) return NextResponse.json({ ok: false, error: "agent not found or inactive" }, { status: 400 });

  const count = Math.max(1, Math.min(5, Math.round(Number(body?.count) || 1)));
  const sent: { lead_id: string; full_name: string }[] = [];
  for (let i = 0; i < count; i++) {
    sent.push(await createTestLead(db, agent, { phone: body?.phone ?? null, by: "admin" }));
  }
  await logAudit(req, "test_lead_send", agent.id, { count });
  return NextResponse.json({ ok: true, sent });
}
