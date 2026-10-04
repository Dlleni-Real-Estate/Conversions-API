import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest, touchPresence } from "@/lib/agents";
import { CLOSED_STATUSES, dictionaryFor, previewAnswers, type AgentLeadRow } from "@/lib/agentLeads";

export const dynamic = "force-dynamic";

/**
 * What the phone polls every ~15 seconds while the agent is on shift. Kept
 * small on purpose - it is the most frequent request this app serves.
 *
 *   ring  leads handed to this agent that they have not opened yet. The app
 *         rings, call-style, until each one is opened.
 *   due   follow-ups whose time has come. The app notifies once.
 *
 * The poll is also the agent's heartbeat: routing prefers agents whose app
 * checked in during the last fifteen minutes.
 */
export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  await touchPresence(db, agent, req.headers.get("x-app-version"));

  const now = Date.now();
  const [ringRes, dueRes, newCount] = await Promise.all([
    db
      .from("leads")
      .select("lead_id,full_name,phone,status,campaign_name,form_id,raw_fields,assigned_at")
      .eq("agent_id", agent.id)
      .eq("status", "new")
      .is("acked_at", null)
      .gte("assigned_at", new Date(now - 24 * 3600_000).toISOString())
      .order("assigned_at", { ascending: true })
      .limit(10),
    db
      .from("leads")
      .select("lead_id,full_name,phone,follow_up_at")
      .eq("agent_id", agent.id)
      .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
      .lte("follow_up_at", new Date(now + 30_000).toISOString())
      .gte("follow_up_at", new Date(now - 12 * 3600_000).toISOString())
      .order("follow_up_at", { ascending: true })
      .limit(10),
    db
      .from("leads")
      .select("lead_id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .eq("status", "new"),
  ]);

  const ring = (ringRes.data ?? []) as AgentLeadRow[];
  const dict = await dictionaryFor(db, ring.map((l) => l.form_id));

  return NextResponse.json({
    ok: true,
    server_time: new Date(now).toISOString(),
    agent: { id: agent.id, name: agent.name, available: agent.available },
    new_count: newCount.count ?? 0,
    ring: ring.map((l) => ({
      lead_id: l.lead_id,
      name: l.full_name,
      phone: l.phone,
      campaign: l.campaign_name,
      assigned_at: l.assigned_at,
      answers: previewAnswers(dict, l.raw_fields, 2),
    })),
    due: (dueRes.data ?? []).map((l) => ({
      lead_id: l.lead_id as string,
      name: l.full_name as string | null,
      phone: l.phone as string | null,
      follow_up_at: l.follow_up_at as string,
    })),
  });
}
