import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { SENDER, APP_SENDS_EVENTS } from "@/lib/sender";
import { CRM_CONFIGURED } from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * One page of truth about whether the machine is actually running.
 *
 * Every number here answers a question that otherwise takes spelunking
 * through three dashboards to answer:
 *
 *   syncRuns   — did the last sync finish, and when? A cron that dies stays
 *                dead silently; this is where that shows first.
 *   capi       — of the events we tried to hand Meta this week, how many did
 *                it take? `failed` growing is the only early sign of a broken
 *                token or a payload regression.
 *   crm        — how much of the CRM the mirror reached last run, and whether
 *                it met stage ids it does not know (those are counted, never
 *                guessed at).
 *   sender     — who is talking to Meta. Exactly one party may; the CRM's own
 *                integration existing at all makes this worth watching.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  const countEvents = async (status: string) => {
    const { count } = await db
      .from("capi_events")
      .select("id", { count: "exact", head: true })
      .eq("status", status)
      .gte("created_at", weekAgo);
    return count ?? 0;
  };

  const [lastRun, sent, failed, pending, lastFailure, crmSetting, leadTotal] = await Promise.all([
    db.from("sync_runs").select("started_at,finished_at,ok,error,leads_found,leads_new")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    countEvents("sent"),
    countEvents("failed"),
    countEvents("pending"),
    db.from("capi_events").select("last_error,created_at").eq("status", "failed")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("app_settings").select("value").eq("key", "last_crm_sync").maybeSingle(),
    db.from("leads").select("lead_id", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    ok: true,
    sender: SENDER,
    appSends: APP_SENDS_EVENTS,
    crmConfigured: CRM_CONFIGURED,
    // With the app sending, 8X's own integration must stay off — one sender.
    dualSenderRisk: APP_SENDS_EVENTS && CRM_CONFIGURED,
    leads: leadTotal.count ?? 0,
    lastSync: lastRun.data ?? null,
    capi7d: {
      sent, failed, pending,
      lastError: lastFailure.data?.last_error ?? null,
      lastErrorAt: lastFailure.data?.created_at ?? null,
    },
    crm: crmSetting.data?.value ?? null,
  });
}
