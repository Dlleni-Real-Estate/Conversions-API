import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { agentFromRequest, touchPresence } from "@/lib/agents";
import { CLOSED_STATUSES, dictionaryFor, previewAnswers, type AgentLeadRow } from "@/lib/agentLeads";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";

export const dynamic = "force-dynamic";

/** A callback this old that nobody acted on stops ringing; it stays in the list. */
const DUE_WINDOW_MS = 12 * 3600_000;
/** How far ahead the phone needs to know, to set its next alarm. */
const UPCOMING_WINDOW_MS = 48 * 3600_000;

type FollowRow = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  status: Status;
  campaign_name: string | null;
  follow_up_at: string;
  last_call_at: string | null;
};

const callback = (l: FollowRow) => ({
  lead_id: l.lead_id,
  name: l.full_name,
  phone: l.phone,
  campaign: l.campaign_name,
  follow_up_at: l.follow_up_at,
  at_ms: Date.parse(l.follow_up_at),
  status: l.status,
  stage_en: STAGE_BY_STATUS[l.status]?.label ?? l.status,
  stage_ar: STAGE_BY_STATUS[l.status]?.labelAr ?? l.status,
});

/**
 * What the phone polls every ~15 seconds while the agent is on shift. Kept
 * small on purpose - it is the most frequent request this app serves.
 *
 *   ring      leads handed to this agent that they have not opened yet. The
 *             app rings, call-style, until each one is opened.
 *   due       callbacks whose time has come and that nobody has called since:
 *             "no answer, try again in 30 minutes" - 30 minutes later the
 *             phone rings again, like a call, until the agent calls or snoozes.
 *   upcoming  the next callbacks, so the phone can set an alarm that fires at
 *             that minute even if the app has been closed.
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
  const followCols = "lead_id,full_name,phone,status,campaign_name,follow_up_at,last_call_at";
  const [ringRes, dueRes, upRes, newCount] = await Promise.all([
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
      .select(followCols)
      .eq("agent_id", agent.id)
      .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
      .lte("follow_up_at", new Date(now + 30_000).toISOString())
      .gte("follow_up_at", new Date(now - DUE_WINDOW_MS).toISOString())
      .order("follow_up_at", { ascending: true })
      .limit(20),
    db
      .from("leads")
      .select(followCols)
      .eq("agent_id", agent.id)
      .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
      .gt("follow_up_at", new Date(now + 30_000).toISOString())
      .lte("follow_up_at", new Date(now + UPCOMING_WINDOW_MS).toISOString())
      .order("follow_up_at", { ascending: true })
      .limit(5),
    db
      .from("leads")
      .select("lead_id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .eq("status", "new"),
  ]);

  const ring = (ringRes.data ?? []) as AgentLeadRow[];
  const dict = await dictionaryFor(db, ring.map((l) => l.form_id));

  // Called at or after the callback time = dealt with. A call made earlier
  // (before the time came) does not count: the agent asked to try again then.
  const due = ((dueRes.data ?? []) as FollowRow[]).filter(
    (l) => !l.last_call_at || Date.parse(l.last_call_at) < Date.parse(l.follow_up_at)
  );

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
      assigned_ms: l.assigned_at ? Date.parse(l.assigned_at) : 0,
      answers: previewAnswers(dict, l.raw_fields, 2),
    })),
    due: due.map(callback),
    upcoming: ((upRes.data ?? []) as FollowRow[]).map(callback),
  });
}
