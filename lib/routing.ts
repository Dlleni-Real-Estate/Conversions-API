/**
 * Handing routed campaigns' leads to agents.
 *
 * The decision itself - which agent, under which locks - lives in the
 * database (route_lead in migration 0014), because two writers can see the
 * same new lead at once and only Postgres can make that safe. This file is
 * the part around it: which leads are waiting, the speed rule that moves a
 * lead nobody called, and the admin's explicit backfill.
 */

import { supabaseAdmin } from "./supabase";

type DB = ReturnType<typeof supabaseAdmin>;

export type RoutingRule = {
  campaign_id: string;
  campaign_name: string | null;
  ad_account_id: string | null;
  enabled: boolean;
  since: string;
  reassign_after_min: number | null;
};

/**
 * An unassigned lead of a routed campaign is held back from the 8X push this
 * long, so the routing tick (every minute) gets it first. Past this, nobody
 * eligible took it - no agent active in the rule - and 8X is the fallback that
 * makes sure somebody still calls.
 */
export const CRM_HOLD_MS = 15 * 60_000;

/** A reassigned lead moves at most this many times. */
const MAX_REASSIGNS = 2;

export async function routingRules(db: DB, enabledOnly = true): Promise<RoutingRule[]> {
  let q = db.from("campaign_routing").select("campaign_id,campaign_name,ad_account_id,enabled,since,reassign_after_min");
  if (enabledOnly) q = q.eq("enabled", true);
  const { data, error } = await q;
  // Table missing (migration not applied yet) reads as "nothing routed", so
  // the sync carries on exactly as it did before this feature existed.
  if (error) return [];
  return (data ?? []) as RoutingRule[];
}

export async function routedCampaignIds(db: DB): Promise<Set<string>> {
  return new Set((await routingRules(db)).map((r) => r.campaign_id));
}

/**
 * Hand out every waiting lead of every routed campaign, oldest first. Safe to
 * call from anywhere, any number of times: route_lead returns the existing
 * agent for a lead that already has one, and does nothing for a lead that
 * arrived before its rule was switched on.
 */
export async function routePending(db: DB, limit = 100): Promise<{ routed: number; waiting: number }> {
  const rules = await routingRules(db);
  if (rules.length === 0) return { routed: 0, waiting: 0 };

  const since = new Map(rules.map((r) => [r.campaign_id, Date.parse(r.since)]));
  const oldest = new Date(Math.min(...[...since.values()])).toISOString();

  const { data, error } = await db
    .from("leads")
    .select("lead_id,campaign_id,submitted_at")
    .is("agent_id", null)
    .in("campaign_id", [...since.keys()])
    .gte("submitted_at", oldest)
    .order("submitted_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`[routing] cannot read waiting leads: ${error.message}`);
    return { routed: 0, waiting: 0 };
  }

  const waiting = ((data ?? []) as { lead_id: string; campaign_id: string; submitted_at: string }[]).filter(
    (l) => Date.parse(l.submitted_at) >= (since.get(l.campaign_id) ?? Infinity)
  );

  let routed = 0;
  for (const l of waiting) {
    const { data: agentId, error: rErr } = await db.rpc("route_lead", { p_lead_id: l.lead_id, p_mode: "new" });
    if (rErr) console.error(`[routing] lead ${l.lead_id}: ${rErr.message}`);
    else if (agentId) routed++;
  }
  if (waiting.length > 0) console.log(`[routing] routed ${routed}/${waiting.length} waiting lead(s)`);
  return { routed, waiting: waiting.length - routed };
}

/**
 * The speed rule: a lead still untouched N minutes after it was handed out
 * goes to another agent who is on shift right now. Off unless the admin set
 * N on the campaign. Untouched means no call and no stage - an agent who
 * opened the alert but never dialled has not worked the lead.
 */
export async function reassignStale(db: DB): Promise<number> {
  const rules = (await routingRules(db)).filter((r) => r.reassign_after_min);
  let moved = 0;
  for (const rule of rules) {
    const cutoff = new Date(Date.now() - (rule.reassign_after_min as number) * 60_000).toISOString();
    const { data } = await db
      .from("leads")
      .select("lead_id")
      .eq("campaign_id", rule.campaign_id)
      .eq("status", "new")
      .not("agent_id", "is", null)
      .is("first_call_at", null)
      .lt("assigned_at", cutoff)
      .lt("reassign_count", MAX_REASSIGNS)
      // A lead older than a day is not a speed problem any more.
      .gt("assigned_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .limit(50);
    for (const l of (data ?? []) as { lead_id: string }[]) {
      const { data: to } = await db.rpc("route_lead", { p_lead_id: l.lead_id, p_mode: "reassign" });
      if (to) moved++;
    }
  }
  if (moved > 0) console.log(`[routing] reassigned ${moved} untouched lead(s)`);
  return moved;
}

/**
 * The admin asked for a campaign's older, never-worked leads to be handed out
 * too. Only leads still at "new" and with nobody on them: anything the team
 * already touched in 8X stays where it is.
 */
export async function backfillCampaign(db: DB, campaignId: string, hours: number): Promise<number> {
  const since = new Date(Date.now() - Math.min(hours, 24 * 30) * 3600_000).toISOString();
  const { data } = await db
    .from("leads")
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .eq("status", "new")
    .is("agent_id", null)
    .gte("submitted_at", since)
    .order("submitted_at", { ascending: true })
    .limit(300);
  let routed = 0;
  for (const l of (data ?? []) as { lead_id: string }[]) {
    const { data: to } = await db.rpc("route_lead", { p_lead_id: l.lead_id, p_mode: "backfill" });
    if (to) routed++;
  }
  return routed;
}
