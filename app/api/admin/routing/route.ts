import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin, isAuthed } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { backfillCampaign, routePending } from "@/lib/routing";
import { agentsSchemaReady } from "@/lib/schema";
import { activeAccounts } from "@/lib/accounts";
import { listCampaigns, type Campaign } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type DB = ReturnType<typeof supabaseAdmin>;

/**
 * The campaigns that could be routed: every campaign we hold spend or leads
 * for, newest activity first. Read from our own tables rather than Meta, so
 * opening the screen costs nothing and works even when Graph is slow.
 */
async function campaignOptions(db: DB) {
  const since = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
  const [ins, recent] = await Promise.all([
    db.from("campaign_insights").select("campaign_id,campaign_name,ad_account_id,updated_at"),
    db
      .from("leads")
      .select("campaign_id,campaign_name,ad_account_id,submitted_at,status,agent_id")
      .gte("submitted_at", since)
      .order("submitted_at", { ascending: false })
      .limit(5000),
  ]);

  type C = {
    id: string; name: string; ad_account_id: string | null; last: string; leads_7d: number; unworked_72h: number;
    /** Delivering in the latest insights pull: what the admin most likely wants to route. */
    active: boolean;
  };
  const out = new Map<string, C>();
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const threeDays = Date.now() - 72 * 3600_000;

  for (const l of (recent.data ?? []) as {
    campaign_id: string | null; campaign_name: string | null; ad_account_id: string | null;
    submitted_at: string; status: string; agent_id: string | null;
  }[]) {
    if (!l.campaign_id) continue;
    const c = out.get(l.campaign_id) ?? {
      id: l.campaign_id, name: l.campaign_name || l.campaign_id, ad_account_id: l.ad_account_id,
      last: l.submitted_at, leads_7d: 0, unworked_72h: 0, active: false,
    };
    const t = Date.parse(l.submitted_at);
    if (t >= weekAgo) c.leads_7d++;
    if (t >= threeDays && l.status === "new" && !l.agent_id) c.unworked_72h++;
    out.set(l.campaign_id, c);
  }
  for (const i of (ins.data ?? []) as { campaign_id: string; campaign_name: string | null; ad_account_id: string | null; updated_at: string }[]) {
    if (out.has(i.campaign_id)) continue;
    out.set(i.campaign_id, {
      id: i.campaign_id, name: i.campaign_name || i.campaign_id, ad_account_id: i.ad_account_id,
      last: i.updated_at, leads_7d: 0, unworked_72h: 0, active: false,
    });
  }

  // Meta's own word on what is running - and the only way a campaign launched
  // minutes ago, with no leads or insights yet, shows up here at all.
  for (const c of await liveCampaigns(db)) {
    const known = out.get(c.id);
    if (known) known.active = c.effective_status === "ACTIVE";
    else if (c.effective_status === "ACTIVE") {
      out.set(c.id, {
        id: c.id, name: c.name || c.id, ad_account_id: c.ad_account_id ?? null,
        last: c.created_time, leads_7d: 0, unworked_72h: 0, active: true,
      });
    }
  }

  // Running campaigns first, then by recent leads, then by latest activity.
  return [...out.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.leads_7d - a.leads_7d || (a.last < b.last ? 1 : -1)
  );
}

/** Every connected account's campaigns with their delivery status, cached briefly. */
let liveCache: { at: number; list: Campaign[] } | null = null;
async function liveCampaigns(db: DB): Promise<Campaign[]> {
  if (liveCache && Date.now() - liveCache.at < 5 * 60_000) return liveCache.list;
  try {
    const { scopes } = await activeAccounts(db);
    const lists = await Promise.all(scopes.map((sc) => listCampaigns(sc).catch(() => [] as Campaign[])));
    liveCache = { at: Date.now(), list: lists.flat() };
    return liveCache.list;
  } catch {
    return liveCache?.list ?? [];
  }
}

async function rulesWithRoutes(db: DB) {
  const [rules, routes] = await Promise.all([
    db.from("campaign_routing").select("*").order("created_at", { ascending: true }),
    db.from("lead_routes").select("campaign_id,agent_id,weight,assigned"),
  ]);
  if (rules.error) return { error: rules.error.message, rules: [] };
  const by = new Map<string, unknown[]>();
  for (const r of (routes.data ?? []) as { campaign_id: string }[]) by.set(r.campaign_id, [...(by.get(r.campaign_id) ?? []), r]);
  return {
    rules: ((rules.data ?? []) as { campaign_id: string }[]).map((r) => ({ ...r, routes: by.get(r.campaign_id) ?? [] })),
  };
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  if (!(await agentsSchemaReady(db))) return NextResponse.json({ ok: false, error: "schema_pending", rules: [], campaigns: [] });
  const [{ rules, error }, campaigns] = await Promise.all([rulesWithRoutes(db), campaignOptions(db)]);
  return NextResponse.json({ ok: !error, error, rules, campaigns });
}

/**
 * POST, one of:
 *   { campaign_id, campaign_name?, enabled, reassign_after_min?, routes: [{agent_id, weight}], backfill_hours? }
 *   { campaign_id, remove: true }
 *
 * Shares are percentages and must add up to 100 while the rule is on. Saving
 * restarts every agent's count at zero, so a new split applies from the next
 * lead rather than trying to correct for history.
 */
export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });
  const db = supabaseAdmin();
  const body = await req.json().catch(() => null);
  const campaignId = String(body?.campaign_id || "");
  if (!campaignId) return NextResponse.json({ ok: false, error: "campaign_id required" }, { status: 400 });

  if (body?.remove === true) {
    // Leads already handed out stay with their agents; only new ones stop.
    await db.from("campaign_routing").delete().eq("campaign_id", campaignId);
    await logAudit(req, "routing_remove", campaignId);
    return NextResponse.json({ ok: true, ...(await rulesWithRoutes(db)) });
  }

  const enabled = body?.enabled !== false;
  const routes = (Array.isArray(body?.routes) ? body.routes : [])
    .map((r: { agent_id?: unknown; weight?: unknown }) => ({ agent_id: String(r?.agent_id || ""), weight: Math.round(Number(r?.weight)) }))
    .filter((r: { agent_id: string; weight: number }) => r.agent_id && Number.isFinite(r.weight) && r.weight >= 0 && r.weight <= 100);
  const total = routes.reduce((s: number, r: { weight: number }) => s + r.weight, 0);
  if (enabled && (routes.length === 0 || total !== 100)) {
    return NextResponse.json({ ok: false, error: "shares_must_total_100", total }, { status: 400 });
  }
  const reassign = Number(body?.reassign_after_min);
  const reassignAfter = Number.isFinite(reassign) && reassign >= 1 && reassign <= 1440 ? Math.round(reassign) : null;

  // The account comes from what we already hold for the campaign, never a guess.
  let accountId: string | null = typeof body?.ad_account_id === "string" ? body.ad_account_id : null;
  let name: string | null = typeof body?.campaign_name === "string" ? body.campaign_name : null;
  if (!accountId || !name) {
    const opts = await campaignOptions(db);
    const found = opts.find((c) => c.id === campaignId);
    accountId = accountId ?? found?.ad_account_id ?? null;
    name = name ?? found?.name ?? null;
  }

  const { data: existing } = await db.from("campaign_routing").select("enabled,since").eq("campaign_id", campaignId).maybeSingle();
  // Switching on (first time, or after a pause) starts the clock now: leads
  // that arrived while it was off have gone their usual way already.
  const since = !existing || (!existing.enabled && enabled) ? new Date().toISOString() : existing.since;

  const { error: upErr } = await db.from("campaign_routing").upsert(
    { campaign_id: campaignId, campaign_name: name, ad_account_id: accountId, enabled, since, reassign_after_min: reassignAfter },
    { onConflict: "campaign_id" }
  );
  if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });

  await db.from("lead_routes").delete().eq("campaign_id", campaignId);
  if (routes.length > 0) {
    const { error: rErr } = await db
      .from("lead_routes")
      .insert(routes.map((r: { agent_id: string; weight: number }) => ({ campaign_id: campaignId, agent_id: r.agent_id, weight: r.weight })));
    if (rErr) return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
  }

  let backfilled = 0;
  const hours = Number(body?.backfill_hours);
  if (enabled && Number.isFinite(hours) && hours > 0) backfilled = await backfillCampaign(db, campaignId, hours);
  const routing = enabled ? await routePending(db) : { routed: 0, waiting: 0 };

  await logAudit(req, "routing_save", campaignId, { enabled, routes, reassign_after_min: reassignAfter, backfilled });
  return NextResponse.json({ ok: true, backfilled, routed: routing.routed, ...(await rulesWithRoutes(db)) });
}
