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
