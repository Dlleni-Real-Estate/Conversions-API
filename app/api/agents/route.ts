import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import {
  deriveLead,
  summarise,
  TEAM_LEADERS,
  WORK_END_HOUR,
  WORK_START_HOUR,
  WORK_TZ,
  type ActivityRow,
  type AssignmentRow,
  type SpeedLeadInput,
} from "@/lib/speed";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The team screen: how fast each lead was routed and picked up, and a profile
 * per person. Same filters as the rest of the dashboard (account, campaign,
 * ad set) plus a period, so "how did the team do on THIS campaign" is one
 * click. Read-only; both passwords may open it.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const p = req.nextUrl.searchParams;
  const campaign = p.get("campaign");
  const scoped = campaign && campaign !== "all" ? campaign : null;
  const accountParam = (p.get("account") || "").replace(/^act_/, "");
  const account = accountParam && accountParam !== "all" ? accountParam : null;
  const adsetParam = p.get("adset");
  const adset = adsetParam && adsetParam !== "all" ? adsetParam : null;
  const days = Math.max(1, Math.min(365, Number(p.get("days")) || 30));
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();

  let q = db
    .from("leads")
    .select(
      "lead_id,full_name,campaign_id,campaign_name,adset_name,status,quality_score,owner,submitted_at,crm_created_at,crm_pushed_at,crm_returning_since"
    )
    .gte("submitted_at", since)
    .order("submitted_at", { ascending: false })
    .limit(3000);
  if (scoped) q = q.eq("campaign_id", scoped);
  if (account) q = q.eq("ad_account_id", account);
  if (adset) q = q.eq("adset_id", adset);

  const { data: leadRows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const leads = (leadRows ?? []) as SpeedLeadInput[];
  const ids = leads.map((l) => l.lead_id);

  // Both logs for exactly these leads, in slices small enough for a URL.
  const assignments: AssignmentRow[] = [];
  const activities: ActivityRow[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const slice = ids.slice(i, i + 300);
    const [a, x] = await Promise.all([
      db.from("lead_assignments").select("lead_id,user_id,user_name,assigned_at").in("lead_id", slice),
      db.from("lead_activities").select("lead_id,kind,at,actor,approx,to_status").in("lead_id", slice),
    ]);
    if (a.error) return NextResponse.json({ error: a.error.message }, { status: 500 });
    if (x.error) return NextResponse.json({ error: x.error.message }, { status: 500 });
    assignments.push(...((a.data ?? []) as AssignmentRow[]));
    activities.push(...((x.data ?? []) as ActivityRow[]));
  }

  const aBy = new Map<string, AssignmentRow[]>();
  for (const a of assignments) aBy.set(a.lead_id, [...(aBy.get(a.lead_id) ?? []), a]);
  const xBy = new Map<string, ActivityRow[]>();
  for (const x of activities) xBy.set(x.lead_id, [...(xBy.get(x.lead_id) ?? []), x]);

  // When the assignment log started. Leads that arrived before it are listed
  // with estimated times and kept out of the medians (see lib/speed.ts).
  const { data: firstLogged } = await db
    .from("lead_assignments")
    .select("first_seen_at")
    .order("first_seen_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const trackingSince = firstLogged?.first_seen_at ? Date.parse(firstLogged.first_seen_at) : null;

  const now = Date.now();
  const rows = leads.map((l) =>
    deriveLead(l, aBy.get(l.lead_id) ?? [], xBy.get(l.lead_id) ?? [], now, trackingSince)
  );
  const { team, people } = summarise(rows);

  return NextResponse.json({
    ok: true,
    days,
    hours: { tz: WORK_TZ, start: WORK_START_HOUR, end: WORK_END_HOUR },
    leaders: [...TEAM_LEADERS],
    tracking_since: firstLogged?.first_seen_at ?? null,
    team,
    people,
    leads: rows,
  });
}
