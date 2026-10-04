import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * POST { lead_id, agent_id | null } - the manager moves one lead by hand.
 *
 * The new agent's phone rings for it on their next check-in, the same as a
 * routed lead. null takes the lead off the app entirely, back to 8X's care.
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });
  const db = supabaseAdmin();
  const body = await req.json().catch(() => null);
  const leadId = String(body?.lead_id || "");
  if (!leadId) return NextResponse.json({ ok: false, error: "lead_id required" }, { status: 400 });

  const { data: lead } = await db.from("leads").select("lead_id,agent_id,tried_agent_ids").eq("lead_id", leadId).maybeSingle();
  if (!lead) return NextResponse.json({ ok: false, error: "lead not found" }, { status: 404 });

  if (!body?.agent_id) {
    await db.from("leads").update({ agent_id: null, assigned_at: null, acked_at: null }).eq("lead_id", leadId);
    await db.from("lead_notes").insert({ lead_id: leadId, kind: "assign", body: null, author: "admin" });
    await logAudit(req, "lead_unassign", leadId);
    return NextResponse.json({ ok: true });
  }

  const { data: agent } = await db.from("agents").select("id,name,active").eq("id", String(body.agent_id)).maybeSingle();
  if (!agent || !agent.active) return NextResponse.json({ ok: false, error: "agent not found or inactive" }, { status: 400 });

  const tried = (lead.tried_agent_ids as string[] | null) ?? [];
  await db
    .from("leads")
    .update({
      agent_id: agent.id,
      assigned_at: new Date().toISOString(),
      acked_at: null,
      owner: agent.name,
      tried_agent_ids: lead.agent_id && lead.agent_id !== agent.id ? [...tried, lead.agent_id] : tried,
    })
    .eq("lead_id", leadId);
  await db.from("lead_notes").insert({ lead_id: leadId, kind: "assign", body: agent.name, author: "admin" });
  await logAudit(req, "lead_assign", leadId, { agent: agent.name });
  return NextResponse.json({ ok: true });
}
