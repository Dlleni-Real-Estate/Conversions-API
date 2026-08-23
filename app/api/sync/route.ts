import { NextRequest, NextResponse } from "next/server";
import {
  listCampaigns,
  listCampaignAds,
  fetchAdLeads,
  listLeadForms,
  fetchCampaignAdInsights,
  fetchCampaignInsights,
  fetchFormSchema,
  flattenFields,
  normalizeEgyptPhone,
} from "@/lib/meta";
import { resolveCampaigns } from "@/lib/tracking";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { capiEventId, sendLeadEvents } from "@/lib/capi";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { APP_SENDS_EVENTS, SENDER } from "@/lib/sender";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Re-reads a slice of history on every run so a lead that arrives out of order
 * (or lands while a sync is mid-flight) is not skipped forever. Cheap, because
 * `ignoreDuplicates` makes re-reading a no-op at the database.
 */
const OVERLAP_MS = 2 * 60 * 60 * 1000;

/**
 * Pulls leads from the TRACKED campaigns only — see lib/tracking.ts for how a
 * campaign becomes tracked (new ones are, automatically).
 *
 * `?full=1` ignores the watermark and re-reads every lead of those campaigns.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const full = req.nextUrl.searchParams.get("full") === "1";
  const db = supabaseAdmin();
  const startedAt = new Date().toISOString();

  const { data: run } = await db.from("sync_runs").insert({ started_at: startedAt }).select("id").single();

  let adsSeen = 0;
  let leadsFound = 0;
  let leadsNew = 0;
  let insightsRows = 0;
  let stageEvents = 0;
  const perCampaign: {
    campaign: string;
    ads: number;
    found: number;
    inserted: number;
    spend?: number;
    error?: string;
  }[] = [];

  try {
    const { cutoff, states, tracked } = await resolveCampaigns(db, await listCampaigns());

    // The lead object carries form_id but not the form's title, and the title
    // is what the dashboard shows. One paged call for the whole Page, resolved
    // once per run rather than once per lead.
    const formIdsSeen = new Set<string>();
    const formNames = new Map<string, string>();
    if (tracked.length > 0) {
      try {
        for (const f of await listLeadForms()) formNames.set(f.id, f.name);
      } catch {
        // A missing form title is cosmetic — never fail a sync over it.
      }
    }

    for (const campaign of tracked) {
      try {
        // One watermark per campaign, not per ad: a campaign's ads share a
        // timeline, and this keeps it to a single query however many ads run.
        let since: number | undefined;
        if (!full) {
          const { data: newest } = await db
            .from("leads")
            .select("submitted_at")
            .eq("campaign_id", campaign.id)
            .order("submitted_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (newest?.submitted_at) {
            since = Math.floor((new Date(newest.submitted_at).getTime() - OVERLAP_MS) / 1000);
          }
        }

        const ads = await listCampaignAds(campaign.id);
        adsSeen += ads.length;

        const rows: Record<string, unknown>[] = [];
        let found = 0;

        for (const ad of ads) {
          const raw = await fetchAdLeads(ad.id, since);
          found += raw.length;

          for (const lead of raw) {
            const { fields, full_name, phone, email } = flattenFields(lead);
            rows.push({
              lead_id: lead.id,
              form_id: lead.form_id ?? null,
              form_name: (lead.form_id && formNames.get(lead.form_id)) || null,
              page_id: process.env.META_PAGE_ID,
              // Names come from the walk, so they are right even when Meta
              // omits them from the lead object.
              ad_id: ad.id,
              ad_name: ad.name,
              adset_id: ad.adset_id ?? lead.adset_id ?? null,
              adset_name: ad.adset_name ?? lead.adset_name ?? null,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              platform: lead.platform ?? null,
              is_organic: lead.is_organic ?? false,
              submitted_at: lead.created_time,
              full_name: full_name ?? null,
              phone: normalizeEgyptPhone(phone) ?? null,
              email: email ?? null,
              raw_fields: fields,
              synced_at: new Date().toISOString(),
            });
          }
        }

        leadsFound += found;
        for (const r of rows) if (r.form_id) formIdsSeen.add(String(r.form_id));

        if (rows.length === 0) {
          const spend = await refreshInsights(db, campaign.id, campaign.created_time).then(
            (r) => {
              insightsRows += r.rows;
              return r.spend;
            },
            () => undefined
          );
          perCampaign.push({ campaign: campaign.name, ads: ads.length, found: 0, inserted: 0, spend });
          continue;
        }

        // ignoreDuplicates keeps a re-sync from wiping the sales team's status.
        const { data: inserted, error } = await db
          .from("leads")
          .upsert(rows, { onConflict: "lead_id", ignoreDuplicates: true })
          .select("lead_id");

        if (error) throw new Error(error.message);
        const n = inserted?.length ?? 0;
        leadsNew += n;

        perCampaign.push({
          campaign: campaign.name,
          ads: ads.length,
          found,
          inserted: n,
          spend: await refreshInsights(db, campaign.id, campaign.created_time).then(
            (r) => {
              insightsRows += r.rows;
              return r.spend;
            },
            () => undefined
          ),
        });
      } catch (err) {
        perCampaign.push({
          campaign: campaign.name,
          ads: 0,
          found: 0,
          inserted: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The wording of each form — what the customer actually read — so the
    // dashboard can show the Arabic question and answer instead of Meta's keys.
    const formsStored = await refreshFormSchemas(db, formIdsSeen);

    // Every stage each lead has reached, for any that never made it to Meta.
    stageEvents = await sendMissingStageEvents(db);

    if (run?.id) {
      await db
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          forms_seen: adsSeen,
          leads_found: leadsFound,
          leads_new: leadsNew,
          ok: true,
        })
        .eq("id", run.id);
    }

    // Printed so a cron run can be read back from the platform log. Without it
    // the only record of what a scheduled sync did is the HTTP status, and a
    // sync that sent nothing looks exactly like one that sent everything.
    console.log(
      `[sync] campaigns=${tracked.length}/${states.length} ads=${adsSeen} ` +
        `leads=${leadsFound} new=${leadsNew} stageEvents=${stageEvents} ` +
        `insights=${insightsRows} forms=${formsStored}`
    );

    return NextResponse.json({
      ok: true,
      cutoff,
      campaignsTotal: states.length,
      campaignsTracked: tracked.length,
      adsSeen,
      leadsFound,
      leadsNew,
      insightsRows,
      stageEvents,
      formsStored,
      perCampaign,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run?.id) {
      await db
        .from("sync_runs")
        .update({ finished_at: new Date().toISOString(), ok: false, error: message })
        .eq("id", run.id);
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * Pull lifetime delivery + spend for every ad in the campaign and store it.
 * Kept separate from the lead walk so a failure here degrades the money
 * columns rather than losing leads: the caller catches and moves on.
 */
async function refreshInsights(
  db: ReturnType<typeof supabaseAdmin>,
  campaignId: string,
  createdTime?: string
): Promise<{ rows: number; spend: number }> {
  // Campaign level FIRST, because that is the number the dashboard reports.
  // It is taken from Meta verbatim rather than added up from the ad rows —
  // reach is deduplicated people, so adding it double-counts anyone who saw
  // two ads, and that is exactly how a dashboard starts disagreeing with
  // Ads Manager.
  const campaign = await fetchCampaignInsights(campaignId, createdTime);
  if (campaign) {
    const { error } = await db
      .from("campaign_insights")
      .upsert({ ...campaign, updated_at: new Date().toISOString() }, { onConflict: "campaign_id" });
    if (error) throw new Error(error.message);
  }

  const ads = await fetchCampaignAdInsights(campaignId, createdTime);
  if (ads.length > 0) {
    const { error } = await db.from("ad_insights").upsert(
      ads.map((i) => ({ ...i, updated_at: new Date().toISOString() })),
      { onConflict: "ad_id" }
    );
    if (error) throw new Error(error.message);
  }

  return { rows: ads.length, spend: campaign?.spend ?? 0 };
}

/**
 * Store the wording of every form we saw leads from. Refreshed weekly: form
 * copy changes rarely, and a stale label is a cosmetic problem, not a data one.
 */
async function refreshFormSchemas(
  db: ReturnType<typeof supabaseAdmin>,
  formIds: Set<string>
): Promise<number> {
  if (formIds.size === 0) return 0;

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data: fresh } = await db
    .from("lead_forms")
    .select("form_id")
    .in("form_id", [...formIds])
    .gt("updated_at", weekAgo);

  const known = new Set((fresh ?? []).map((f: { form_id: string }) => f.form_id));
  const stale = [...formIds].filter((id) => !known.has(id));
  if (stale.length === 0) return 0;

  const schemas = [];
  for (const id of stale) {
    try {
      schemas.push({ ...(await fetchFormSchema(id)), updated_at: new Date().toISOString() });
    } catch {
      // A form we cannot read just falls back to showing its keys.
    }
  }
  if (schemas.length === 0) return 0;

  await db.from("lead_forms").upsert(schemas, { onConflict: "form_id" });
  return schemas.length;
}

/**
 * Makes Meta's picture of each lead match ours, and heals it when they drift.
 *
 * Two things have to be true for a lead to count, and neither is automatic:
 *
 * 1. Meta wants a raw-lead event for EVERY lead its campaigns produced, uploaded
 *    by us. Its own words: "If your campaigns generate 100 leads, then Meta
 *    expects 100 'Raw Lead' events uploaded to represent the first lead stage."
 *    This is not the Lead event Meta fires itself on form submit. It is the
 *    denominator: every stage's conversion rate — and therefore the 1%–40%
 *    eligibility rule — is measured against it.
 *
 * 2. Meta counts a lead as having reached a stage only if we sent THAT stage's
 *    event, so a lead sitting at "Site visit done" needs the stages beneath it
 *    too. /api/feedback sends the whole chain on the move; this is the net that
 *    catches whatever that missed — a failed request, a lead stored before this
 *    code existed, or a payload version bump that made earlier events wrong.
 *
 * Bounded to the last 7 days because that is Meta's backfill limit: older events
 * are discarded, and lying about event_time to get around it makes Meta discard
 * the lot. Bounded again by `maxEvents` so one sweep cannot outrun the function
 * timeout — whatever is left is picked up by the next run ten minutes later.
 */
async function sendMissingStageEvents(
  db: ReturnType<typeof supabaseAdmin>,
  limit = 200,
  maxEvents = 400
): Promise<number> {
  // Someone else owns the conversation with Meta — say nothing.
  if (!APP_SENDS_EVENTS) {
    console.log(`[sync] stage sweep: skipped, CAPI_SENDER=${SENDER}`);
    return 0;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  const { data: recent, error: leadErr } = await db
    .from("leads")
    .select("lead_id, phone, email, status, deal_value")
    .gte("submitted_at", sevenDaysAgo)
    .order("submitted_at", { ascending: false })
    .limit(limit);

  if (leadErr) console.error("[sync] stage sweep: lead query failed —", leadErr.message);
  if (!recent || recent.length === 0) {
    console.log(`[sync] stage sweep: no leads submitted since ${sevenDaysAgo}`);
    return 0;
  }

  const leadIds = recent.map((l: { lead_id: string }) => l.lead_id);

  // Matched on event_id, not on event_name: the id carries the payload version,
  // so when a correction bumps that version this sweep sees the old rows as a
  // different event and re-sends under the fixed payload.
  const { data: already } = await db
    .from("capi_events")
    .select("event_id")
    .eq("status", "sent")
    .in("lead_id", leadIds);

  const done = new Set((already ?? []).map((r: { event_id: string }) => r.event_id));

  const now = Date.now();
  const missing: Parameters<typeof sendLeadEvents>[0] = [];

  for (const lead of recent as {
    lead_id: string;
    phone: string | null;
    email: string | null;
    status: Status;
    deal_value: number | null;
  }[]) {
    const reached = STAGE_BY_STATUS[lead.status]?.rank ?? 0;
    const chain = STAGES.filter(
      (st) => st.event && (st.rank === 0 || (reached > 0 ? st.rank <= reached : st.rank === reached))
    ).sort((a, b) => a.rank - b.rank);

    chain.forEach((st, i) => {
      if (missing.length >= maxEvents) return;
      if (done.has(capiEventId(lead.lead_id, st.event as string))) return;
      missing.push({
        leadId: lead.lead_id,
        eventName: st.event as string,
        // Now, not the submission time: "when the lead was received and
        // processed", and safely after the generation time — Meta discards
        // events timestamped before the lead existed. Spaced so the order Meta
        // reads is the order the lead walked.
        eventTime: new Date(now - (chain.length - 1 - i) * 1000),
        phone: lead.phone ?? undefined,
        email: lead.email ?? undefined,
        value: st.status === "reservation" ? lead.deal_value : null,
      });
    });
  }

  // Logged before the early return, so "nothing to send" and "nothing sendable"
  // are distinguishable from the outside. Chasing that difference without this
  // line costs a deploy cycle.
  console.log(
    `[sync] stage sweep: leads=${recent.length} alreadySent=${done.size} missing=${missing.length}` +
      (missing[0] ? ` first=${capiEventId(missing[0].leadId, missing[0].eventName)}` : "")
  );
  if (missing.length === 0) return 0;

  const result = await sendLeadEvents(missing).catch((err) => {
    console.error("[sync] stage events failed", err);
    return { attempted: 0, sent: 0, failed: missing.length };
  });
  console.log(
    `[sync] stage events attempted=${result.attempted} sent=${result.sent} failed=${result.failed}`
  );
  return result.sent;
}
