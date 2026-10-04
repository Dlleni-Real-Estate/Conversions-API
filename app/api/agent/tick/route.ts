import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdmin } from "@/lib/auth";
import { activeAccounts } from "@/lib/accounts";
import { fetchAdLeads, fetchFormSchema, listCampaignAds, type AccountScope, type CampaignAd } from "@/lib/meta";
import { leadRow } from "@/lib/ingest";
import { reassignStale, routePending, routingRules } from "@/lib/routing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The agents' fast lane, called every minute by pg_cron.
 *
 * The ten-minute sync walks every tracked campaign and does a dozen other
 * jobs; a lead can sit up to ten minutes before anyone knows it exists. Speed
 * to lead is the whole point of routing, so routed campaigns - and only those
 * - are read here every minute, handed out at once, and the agent's phone
 * rings on its next check-in, about fifteen seconds later.
 *
 * Nothing routed = one cheap query and out, so leaving this scheduled costs
 * nothing until the admin routes a campaign.
 */
const BUDGET_MS = 45_000;
/** Re-read this far behind the newest stored lead, for leads Meta lists late. */
const OVERLAP_MS = 15 * 60_000;
/** A campaign's ad list changes rarely; asking Meta every minute is waste. */
const ADS_TTL_MS = 10 * 60_000;
const adsCache = new Map<string, { at: number; ads: CampaignAd[] }>();

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const db = supabaseAdmin();

  const rules = await routingRules(db);
  if (rules.length === 0) return NextResponse.json({ ok: true, skipped: "no routed campaigns" });

  const { scopes } = await activeAccounts(db);
  const { data: formRows } = await db.from("lead_forms").select("form_id,name");
  const formNames = new Map(
    ((formRows ?? []) as { form_id: string; name: string | null }[]).map((f) => [String(f.form_id), f.name ?? ""])
  );

  let found = 0;
  let inserted = 0;
  const errors: string[] = [];
  const newForms = new Map<string, AccountScope>();

  for (const rule of rules) {
    if (left() < 10_000) break;

    // Which account owns the campaign is never guessed - a wrong one sends its
    // events to another dataset. Saved with the rule; else read off its leads.
    let accountId = rule.ad_account_id;
    if (!accountId) {
      const { data } = await db
        .from("leads").select("ad_account_id").eq("campaign_id", rule.campaign_id)
        .not("ad_account_id", "is", null).limit(1).maybeSingle();
      accountId = (data?.ad_account_id as string | undefined) ?? null;
    }
    const scope = scopes.find((s) => s.adAccountId === accountId);
    if (!scope) {
      errors.push(`${rule.campaign_name || rule.campaign_id}: ad account unknown or inactive`);
      continue;
    }

    try {
      const { data: newest } = await db
        .from("leads").select("submitted_at").eq("campaign_id", rule.campaign_id)
        .order("submitted_at", { ascending: false }).limit(1).maybeSingle();
      const floor = Date.parse(rule.since) - 5 * 60_000;
      const from = newest?.submitted_at ? Math.max(Date.parse(newest.submitted_at) - OVERLAP_MS, floor) : floor;
      const since = Math.floor(from / 1000);

      const cached = adsCache.get(rule.campaign_id);
      const ads =
        cached && Date.now() - cached.at < ADS_TTL_MS
          ? cached.ads
          : await listCampaignAds(rule.campaign_id, scope).then((a) => {
              adsCache.set(rule.campaign_id, { at: Date.now(), ads: a });
              return a;
            });

      const campaign = { id: rule.campaign_id, name: rule.campaign_name || rule.campaign_id };
      const rows: Record<string, unknown>[] = [];
      // A few ads at a time: parallel enough to be quick, polite enough not to
      // trip the Page's lead-read rate limit the ten-minute sync also uses.
      for (let i = 0; i < ads.length && left() > 6_000; i += 4) {
        const batch = await Promise.all(ads.slice(i, i + 4).map((ad) => fetchAdLeads(ad.id, since, scope).then((r) => ({ ad, r }))));
        for (const { ad, r } of batch) for (const lead of r) rows.push(leadRow(lead, ad, campaign, scope, formNames));
      }
      found += rows.length;
      if (rows.length === 0) continue;

      const { data: ins, error } = await db
        .from("leads")
        .upsert(rows, { onConflict: "lead_id", ignoreDuplicates: true })
        .select("lead_id");
      if (error) throw new Error(error.message);
      inserted += ins?.length ?? 0;
      for (const r of rows) {
        const f = r.form_id ? String(r.form_id) : "";
        if (f && !formNames.has(f)) newForms.set(f, scope);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tick] "${rule.campaign_name || rule.campaign_id}" failed: ${msg}`);
      errors.push(`${rule.campaign_name || rule.campaign_id}: ${msg}`);
    }
  }

  // Hand them out before anything else - this is what makes phones ring.
  const routing = await routePending(db);
  const reassigned = await reassignStale(db);

  // A brand-new form's wording, so the agent reads the customer's questions
  // and not machine keys. The ten-minute sync would get there too, later.
  let forms = 0;
  for (const [formId, scope] of [...newForms].slice(0, 3)) {
    if (left() < 4_000) break;
    try {
      const schema = await fetchFormSchema(formId, scope);
      await db.from("lead_forms").upsert({ ...schema, updated_at: new Date().toISOString() }, { onConflict: "form_id" });
      forms++;
    } catch {
      // Cosmetic; the sync retries it.
    }
  }

  console.log(
    `[tick] rules=${rules.length} found=${found} new=${inserted} routed=${routing.routed} waiting=${routing.waiting} ` +
      `reassigned=${reassigned} forms=${forms} took=${Date.now() - started}ms` +
      (errors.length ? ` errors=${errors.join(" | ")}` : "")
  );
  return NextResponse.json({ ok: true, rules: rules.length, found, inserted, routing, reassigned, forms, errors });
}
