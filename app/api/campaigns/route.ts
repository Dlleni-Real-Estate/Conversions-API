import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, type Campaign } from "@/lib/meta";
import { activeAccounts } from "@/lib/accounts";
import { resolveCampaigns, setCutoff, setOverride, clearOverride } from "@/lib/tracking";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type DB = ReturnType<typeof supabaseAdmin>;

/**
 * Every campaign on EVERY connected ad account, with whether we watch it.
 *
 * Listing only the environment's account was the bug that made connecting a
 * second account pointless: its campaigns never appeared here, so they could
 * never be switched on, so the account did nothing at all. One account failing
 * to list does not hide the others - that failure is reported beside them.
 */
async function everyCampaign(db: DB): Promise<{
  campaigns: Campaign[];
  accounts: { ad_account_id: string; name?: string; error?: string }[];
  skipped: { ad_account_id: string; name?: string; reason: string }[];
}> {
  const { scopes, skipped } = await activeAccounts(db);

  const results = await Promise.all(
    scopes.map(async (scope) => {
      try {
        return { scope, campaigns: await listCampaigns(scope), error: undefined as string | undefined };
      } catch (err) {
        return { scope, campaigns: [] as Campaign[], error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const campaigns = results.flatMap((r) => r.campaigns);
  campaigns.sort((a, b) => (a.created_time < b.created_time ? 1 : -1));

  return {
    campaigns,
    accounts: results.map((r) => ({
      ad_account_id: r.scope.adAccountId,
      name: r.scope.name,
      error: r.error,
    })),
    skipped: skipped.map((s) => ({ ad_account_id: s.adAccountId, name: s.name, reason: s.reason })),
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  try {
    const all = await everyCampaign(db);
    const { cutoff, states } = await resolveCampaigns(db, all.campaigns);
    return NextResponse.json({
      ok: true,
      cutoff,
      campaigns: states,
      accounts: all.accounts,
      skippedAccounts: all.skipped,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * Body is one of:
 *   { cutoff: "2026-08-01" }                         move the date line
 *   { campaign_id, enabled: true|false, name?, created_time? }   pin a campaign
 *   { campaign_id, enabled: null }                   unpin - back to the date rule
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });

  const db = supabaseAdmin();
  try {
    const body = (await req.json()) as {
      cutoff?: string;
      campaign_id?: string;
      enabled?: boolean | null;
      name?: string;
      created_time?: string;
    };

    if (typeof body.cutoff === "string") {
      await setCutoff(db, body.cutoff);
      await logAudit(req, "cutoff_change", body.cutoff);
    } else if (typeof body.campaign_id === "string") {
      await logAudit(req, "campaign_pin", body.campaign_id, { enabled: body.enabled, name: body.name ?? null });
      if (body.enabled === null) {
        await clearOverride(db, body.campaign_id);
      } else if (typeof body.enabled === "boolean") {
        await setOverride(
          db,
          { id: body.campaign_id, name: body.name, created_time: body.created_time },
          body.enabled
        );
      } else {
        return NextResponse.json({ ok: false, error: "enabled must be true, false or null" }, { status: 400 });
      }
    } else {
      return NextResponse.json({ ok: false, error: "nothing to change" }, { status: 400 });
    }

    const all = await everyCampaign(db);
    const { cutoff, states } = await resolveCampaigns(db, all.campaigns);
    return NextResponse.json({
      ok: true,
      cutoff,
      campaigns: states,
      accounts: all.accounts,
      skippedAccounts: all.skipped,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
