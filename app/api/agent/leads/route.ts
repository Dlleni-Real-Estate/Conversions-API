import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest, cairoMidnight, medianOf } from "@/lib/agents";
import { AGENT_LEAD_COLUMNS, CLOSED_STATUSES, dictionaryFor, type AgentLeadRow } from "@/lib/agentLeads";

export const dynamic = "force-dynamic";

/**
 * GET ?view=new|follow|all&q= - the signed-in agent's own leads, nobody else's.
 *
 *   new     never worked: oldest waiting first, because that is the order
 *           they should be called in
 *   follow  someone to call again: a follow-up time, or a call that did not
 *           connect. Soonest follow-up first
 *   all     everything handed to them, newest first
 */
export async function GET(req: NextRequest) {
  const db = supabaseAdmin();
  const agent = await agentFromRequest(req, db);
  if (!agent) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const view = p.get("view") || "new";

  let q = db.from("leads").select(AGENT_LEAD_COLUMNS).eq("agent_id", agent.id).limit(300);
  if (view === "new") {
    q = q.eq("status", "new").order("assigned_at", { ascending: true });
  } else if (view === "follow") {
    q = q
      .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
      .neq("status", "new")
      .or("follow_up_at.not.is.null,status.in.(no_answer,unreachable)")
      .order("follow_up_at", { ascending: true, nullsFirst: false })
      .order("last_call_at", { ascending: true, nullsFirst: true });
  } else {
    q = q.order("assigned_at", { ascending: false });
  }

  // Same rule as the dashboard search: phones are stored as 20xxxxxxxxxx but
  // typed as 010..., so every plausible stored form is searched.
  const search = (p.get("q") || "").trim().replace(/[,()]/g, " ").slice(0, 60);
  if (search) {
    const ors = [`full_name.ilike.%${search}%`];
    const digits = search.replace(/\D/g, "");
    if (digits.length >= 3) {
      for (const v of new Set([digits, digits.replace(/^0/, "20"), digits.replace(/^20/, "")])) {
        if (v.length >= 3) ors.push(`phone.ilike.%${v}%`);
      }
    }
    q = q.or(ors.join(","));
  }

  const nowIso = new Date().toISOString();
  const todayIso = new Date(cairoMidnight()).toISOString();
  const [list, cNew, cFollowDue, cAll, today] = await Promise.all([
    q,
    db.from("leads").select("lead_id", { count: "exact", head: true }).eq("agent_id", agent.id).eq("status", "new"),
    db
      .from("leads")
      .select("lead_id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
      .lte("follow_up_at", nowIso),
    db.from("leads").select("lead_id", { count: "exact", head: true }).eq("agent_id", agent.id),
    // Today, for the header: what reached the agent and how fast they called.
    db
      .from("leads")
      .select("assigned_at,first_call_at")
      .eq("agent_id", agent.id)
      .gte("assigned_at", todayIso)
      .limit(500),
  ]);
  if (list.error) return NextResponse.json({ ok: false, error: list.error.message }, { status: 500 });

  const todayRows = (today.data ?? []) as { assigned_at: string | null; first_call_at: string | null }[];
  const waits = todayRows
    .filter((r) => r.assigned_at && r.first_call_at)
    .map((r) => Math.max(0, Math.round((Date.parse(r.first_call_at!) - Date.parse(r.assigned_at!)) / 60_000)));

  const leads = (list.data ?? []) as unknown as AgentLeadRow[];
  return NextResponse.json({
    ok: true,
    view,
    agent,
    counts: { new: cNew.count ?? 0, follow_due: cFollowDue.count ?? 0, all: cAll.count ?? 0 },
    today: { assigned: todayRows.length, called: waits.length, median_call_min: medianOf(waits) },
    dictionary: await dictionaryFor(db, leads.map((l) => l.form_id)),
    leads,
  });
}
