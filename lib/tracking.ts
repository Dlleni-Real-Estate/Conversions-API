/**
 * Which campaigns the platform actually watches.
 *
 * The rule is deliberately "new things are in by default, old things are out":
 *
 *   tracked(campaign) =
 *     explicit row in tracked_campaigns ?  row.enabled
 *                                       :  campaign.created_time >= cutoff
 *
 * So launching a campaign in Ads Manager needs no follow-up here — it is picked
 * up on the next sync, and its forms come along with it, because we walk
 * campaign → ads → leads rather than sweeping the Page's forms. The explicit
 * row is the escape hatch in BOTH directions: switch an old campaign back on,
 * or switch a new one off.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Campaign } from "./meta";

/** Used only if the settings row somehow goes missing. */
export const FALLBACK_CUTOFF = "2026-08-01T00:00:00.000Z";

export type CampaignState = Campaign & {
  tracked: boolean;
  /** Why it is on or off — this is what the settings screen explains to the user. */
  reason: "manual-on" | "manual-off" | "auto-new" | "auto-old";
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, any, any>;

export async function getCutoff(db: DB): Promise<string> {
  const { data } = await db.from("app_settings").select("value").eq("key", "campaign_cutoff").maybeSingle();
  const since = (data?.value as { since?: string } | undefined)?.since;
  return since && !Number.isNaN(Date.parse(since)) ? since : FALLBACK_CUTOFF;
}

export async function setCutoff(db: DB, since: string): Promise<void> {
  if (Number.isNaN(Date.parse(since))) throw new Error(`Not a date: ${since}`);
  const { error } = await db
    .from("app_settings")
    .upsert(
      { key: "campaign_cutoff", value: { since: new Date(since).toISOString() }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw new Error(error.message);
}

export async function getOverrides(db: DB): Promise<Map<string, boolean>> {
  const { data } = await db.from("tracked_campaigns").select("campaign_id, enabled");
  return new Map((data || []).map((r: { campaign_id: string; enabled: boolean }) => [r.campaign_id, r.enabled]));
}

export async function setOverride(
  db: DB,
  campaign: { id: string; name?: string; created_time?: string },
  enabled: boolean
): Promise<void> {
  const { error } = await db.from("tracked_campaigns").upsert(
    {
      campaign_id: campaign.id,
      campaign_name: campaign.name ?? null,
      campaign_created_time: campaign.created_time ?? null,
      enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "campaign_id" }
  );
  if (error) throw new Error(error.message);
}

/**
 * Track a newly connected account's campaigns, without waiting to be asked.
 *
 * The cutoff rule ("new things in, old things out") was written for ONE
 * account that had been running long before this system existed. Applied to an
 * account you just deliberately connected, it reads as a bug: the connect
 * succeeds, the dashboard stays empty, and nothing says the campaigns are
 * sitting there switched off. Connecting IS the intent, so it pins them ON.
 *
 * Bounded to what a person would actually mean: campaigns still delivering, or
 * created in the last 90 days. Older, finished campaigns stay off and one
 * click away - a five-year-old account should not drag its whole history in.
 *
 * Written as explicit overrides, so every row is visible in Tracked campaigns
 * and reversible there. Existing overrides are never touched: a campaign
 * someone deliberately switched off stays off through a reconnect.
 */
export async function trackNewAccountCampaigns(
  db: DB,
  campaigns: Campaign[],
  windowDays = 90
): Promise<{ pinned: number; skipped: number }> {
  if (campaigns.length === 0) return { pinned: 0, skipped: 0 };

  const existing = await getOverrides(db);
  const horizon = Date.now() - windowDays * 24 * 3600_000;

  const rows = campaigns
    .filter((c) => !existing.has(c.id))
    .filter((c) => c.effective_status === "ACTIVE" || Date.parse(c.created_time) >= horizon)
    .map((c) => ({
      campaign_id: c.id,
      campaign_name: c.name ?? null,
      campaign_created_time: c.created_time ?? null,
      enabled: true,
      updated_at: new Date().toISOString(),
    }));

  if (rows.length > 0) {
    const { error } = await db.from("tracked_campaigns").upsert(rows, { onConflict: "campaign_id" });
    if (error) throw new Error(error.message);
  }
  return { pinned: rows.length, skipped: campaigns.length - rows.length };
}

/** Drop the manual override so the campaign falls back to the cutoff rule. */
export async function clearOverride(db: DB, campaignId: string): Promise<void> {
  const { error } = await db.from("tracked_campaigns").delete().eq("campaign_id", campaignId);
  if (error) throw new Error(error.message);
}

export function decide(campaign: Campaign, cutoff: string, overrides: Map<string, boolean>): CampaignState {
  const override = overrides.get(campaign.id);
  if (override !== undefined) {
    return { ...campaign, tracked: override, reason: override ? "manual-on" : "manual-off" };
  }
  const isNew = Date.parse(campaign.created_time) >= Date.parse(cutoff);
  return { ...campaign, tracked: isNew, reason: isNew ? "auto-new" : "auto-old" };
}

export async function resolveCampaigns(
  db: DB,
  campaigns: Campaign[]
): Promise<{ cutoff: string; states: CampaignState[]; tracked: CampaignState[] }> {
  const [cutoff, overrides] = await Promise.all([getCutoff(db), getOverrides(db)]);
  const states = campaigns.map((c) => decide(c, cutoff, overrides));
  return { cutoff, states, tracked: states.filter((s) => s.tracked) };
}
