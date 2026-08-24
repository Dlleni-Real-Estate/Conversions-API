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

  const [lastRun, sent, failed, pending, lastFailure, crmSetting, leadTotal, accountRows] = await Promise.all([
    db.from("sync_runs").select("started_at,finished_at,ok,error,leads_found,leads_new")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    countEvents("sent"),
    countEvents("failed"),
    countEvents("pending"),
    db.from("capi_events").select("last_error,created_at").eq("status", "failed")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("app_settings").select("value").eq("key", "last_crm_sync").maybeSingle(),
    db.from("leads").select("lead_id", { count: "exact", head: true }),
    db.from("ad_accounts").select("ad_account_id,name,dataset_id,enabled,verified_at,token_expires_at"),
  ]);

  type AccountRow = {
    ad_account_id: string; name: string | null; dataset_id: string;
    enabled: boolean; verified_at: string | null; token_expires_at: string | null;
  };
  const rows = (accountRows.data ?? []) as AccountRow[];

  return NextResponse.json({
    ok: true,
    sender: SENDER,
    appSends: APP_SENDS_EVENTS,
    crmConfigured: CRM_CONFIGURED,

    // Who is talking to Meta, stated precisely.
    //
    // This used to be one boolean called dualSenderRisk, set whenever an 8X API
    // key existed. That was wrong in a way that mattered: the key is what we
    // READ the CRM with, and reading is not sending. It made a healthy setup
    // look like a double-counting one on every load.
    //
    // Whether 8X's own Meta integration is switched on is a checkbox inside 8X
    // that no API exposes. So it is reported as unknown rather than inferred —
    // an unknown you can go and check beats a boolean that is confidently wrong.
    senders: {
      app: APP_SENDS_EVENTS,
      crmApiConfigured: CRM_CONFIGURED,
      crmIntegrationOn: null as boolean | null,
    },

    // Multi-account state, for the same reason the sync logs it: an account
    // that is connected but unverified explains a campaign that never appears.
    accounts: {
      connected: rows.length,
      active: rows.filter((a) => a.enabled && a.verified_at).length,
      unverified: rows.filter((a) => a.enabled && !a.verified_at)
        .map((a) => a.name || a.ad_account_id),
      paused: rows.filter((a) => !a.enabled).map((a) => a.name || a.ad_account_id),
      // Facebook Login tokens last ~60 days. Fourteen days of warning is
      // enough to re-login before the account silently stops syncing.
      tokenExpiring: rows
        .filter((a) => a.enabled && a.token_expires_at
          && new Date(a.token_expires_at).getTime() < Date.now() + 14 * 24 * 3600_000)
        .map((a) => `${a.name || a.ad_account_id} (${(a.token_expires_at as string).slice(0, 10)})`),
      // Two accounts pointed at one dataset is legal in Meta and almost never
      // intended: their events land in one funnel and neither optimises well.
      sharedDatasets: [
        ...new Set(
          rows.filter((a) => a.enabled)
            .map((a) => a.dataset_id)
            .filter((d, _i, all) => all.filter((x) => x === d).length > 1)
        ),
      ],
    },
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
