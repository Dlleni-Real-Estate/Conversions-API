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
  type AccountScope,
} from "@/lib/meta";
import { activeAccounts, scopeIndex } from "@/lib/accounts";
import { resolveCampaigns } from "@/lib/tracking";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { capiEventId, sendLeadEvents } from "@/lib/capi";
import { chainFor, type Status } from "@/lib/stages";
import { leadQualityScore } from "@/lib/quality";
import { renewExpiringTokens } from "@/lib/oauth";
import { APP_SENDS_EVENTS, SENDER } from "@/lib/sender";
import { CRM_CONFIGURED, crmPage, drainUnknownUserIds, pickLastNote, pickOwner, statusFromCrmStatusId } from "@/lib/crm";

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
  let crm: CrmSyncResult = { skipped: "not configured", scanned: 0, matched: 0, changed: 0, owners: 0, notes: 0 };
  const perCampaign: {
    campaign: string;
    ads: number;
    found: number;
    inserted: number;
    spend?: number;
    error?: string;
  }[] = [];

  try {
    // Every connected ad account, each with the dataset Meta confirmed is
    // connected to it. The rule lives in lib/accounts.ts so that this route and
    // the campaigns route can never disagree about which accounts are live -
    // two copies of one rule is exactly how the last silent bug happened.
    const { scopes: accounts, skipped: skippedAccounts } = await activeAccounts(db);
    for (const s of skippedAccounts) {
      console.warn(`[sync] ad account ${s.adAccountId} skipped: ${s.reason}`);
    }

    // Campaign ids are unique across Meta, so one map is enough to send each
    // campaign's leads, insights and events back to its own account's dataset.
    const scopeOf = new Map<string, AccountScope>();
    const everyCampaign = [];
    for (const acc of accounts) {
      try {
        const cs = await listCampaigns(acc);
        for (const c of cs) scopeOf.set(c.id, acc);
        everyCampaign.push(...cs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync] account ${acc.name || acc.adAccountId} failed to list campaigns: ${msg}`);
        perCampaign.push({
          campaign: `(account ${acc.name || acc.adAccountId})`,
          ads: 0, found: 0, inserted: 0,
          error: msg,
        });
      }
    }

    const { cutoff, states, tracked } = await resolveCampaigns(db, everyCampaign);

    // The lead object carries form_id but not the form's title, and the title
    // is what the dashboard shows. One paged call for the whole Page, resolved
    // once per run rather than once per lead.
    const formIdsSeen = new Set<string>();
    const formNames = new Map<string, string>();
    // Which account's credential can read each form. A form lives on a Page,
    // and only a token that can see that Page can read its schema. Every form
    // on every connected Page is seeded here - not just forms mentioned by
    // this run's new leads - because a form whose schema fetch once failed
    // would otherwise never be retried: quiet campaigns stop producing new
    // mentions of it.
    const formScopes = new Map<string, AccountScope>();
    for (const acc of tracked.length > 0 ? accounts : []) {
      try {
        for (const f of await listLeadForms(acc)) {
          formNames.set(f.id, f.name);
          formIdsSeen.add(f.id);
          if (!formScopes.has(f.id)) formScopes.set(f.id, acc);
        }
      } catch {
        // A missing form title is cosmetic — never fail a sync over it.
      }
    }

    for (const campaign of tracked) {
      // Which account this campaign belongs to is not a guess. If it is somehow
      // unknown, the campaign is skipped and said so: picking "the first
      // account" would send its events to another account's dataset, and Meta
      // answers that with a 200 and attributes nothing.
      const scope = scopeOf.get(campaign.id);
      if (!scope) {
        perCampaign.push({
          campaign: campaign.name,
          ads: 0, found: 0, inserted: 0,
          error: "no connected ad account owns this campaign - skipped rather than guessed",
        });
        continue;
      }
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

        const ads = await listCampaignAds(campaign.id, scope);
        adsSeen += ads.length;

        const rows: Record<string, unknown>[] = [];
        let found = 0;

        for (const ad of ads) {
          const raw = await fetchAdLeads(ad.id, since, scope);
          found += raw.length;

          for (const lead of raw) {
            const { fields, full_name, phone, email } = flattenFields(lead);
            rows.push({
              lead_id: lead.id,
              form_id: lead.form_id ?? null,
              form_name: (lead.form_id && formNames.get(lead.form_id)) || null,
              page_id: scope.pageId || process.env.META_PAGE_ID,
              ad_account_id: scope.adAccountId,
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
        for (const r of rows)
          if (r.form_id) {
            formIdsSeen.add(String(r.form_id));
            if (!formScopes.has(String(r.form_id))) formScopes.set(String(r.form_id), scope);
          }

        if (rows.length === 0) {
          const spend = await refreshInsights(db, campaign.id, campaign.created_time, scope).then(
            (r) => {
              insightsRows += r.rows;
              return r.spend;
            },
            (err) => {
              // Spend staying stale is tolerable; not knowing it went stale is
              // not. Same lesson as the lead reads: name the failure.
              console.error(
                `[sync] insights for "${campaign.name}" failed: ${err instanceof Error ? err.message : err}`
              );
              return undefined;
            }
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
          spend: await refreshInsights(db, campaign.id, campaign.created_time, scope).then(
            (r) => {
              insightsRows += r.rows;
              return r.spend;
            },
            (err) => {
              console.error(
                `[sync] insights for "${campaign.name}" failed: ${err instanceof Error ? err.message : err}`
              );
              return undefined;
            }
          ),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The response carries this too, but nobody reads a cron's response
        // body. The log line is what turns "zero leads, all green" into a
        // named failure - that exact silence hid a Page-token refusal once.
        console.error(`[sync] campaign "${campaign.name}" failed: ${msg}`);
        perCampaign.push({
          campaign: campaign.name,
          ads: 0,
          found: 0,
          inserted: 0,
          error: msg,
        });
      }
    }

    // The wording of each form — what the customer actually read — so the
    // dashboard can show the Arabic question and answer instead of Meta's keys.
    const formsStored = await refreshFormSchemas(db, formIdsSeen, formScopes);

    // What the sales team actually did, read back out of 8X CRM. This is the
    // only thing that fills `status`; nobody types stages into this app.
    crm = await syncCrmStatuses(db);

    // Quality scores follow every stage move the mirror just brought in.
    await refreshQualityScores(db);

    // Once an hour on the sync that lands in the first ten-minute slot: renew
    // any Facebook Login token inside its warning window. This is the only
    // schedule the deployment guarantees, so the renewal lives on it.
    if (new Date().getUTCMinutes() < 10) {
      const t = await renewExpiringTokens();
      if (t.checked > 0) console.log(`[sync] tokens: checked=${t.checked} renewed=${t.refreshed} declined=${t.failed}`);
    }

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
      `[sync] accounts=${accounts.length} campaigns=${tracked.length}/${states.length} ads=${adsSeen} ` +
        `leads=${leadsFound} new=${leadsNew} stageEvents=${stageEvents} ` +
        `insights=${insightsRows} forms=${formsStored} ` +
        `crm=${crm.skipped ?? `${crm.matched}/${crm.scanned} matched, ${crm.changed} moved, ${crm.owners} owners, ${crm.notes} notes`}`
    );

    return NextResponse.json({
      ok: true,
      cutoff,
      accounts: accounts.map((a) => ({ id: a.adAccountId, name: a.name, dataset: a.datasetId })),
      campaignsTotal: states.length,
      campaignsTracked: tracked.length,
      adsSeen,
      leadsFound,
      leadsNew,
      insightsRows,
      stageEvents,
      formsStored,
      crm,
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
  createdTime?: string,
  scope?: AccountScope
): Promise<{ rows: number; spend: number }> {
  // Campaign level FIRST, because that is the number the dashboard reports.
  // It is taken from Meta verbatim rather than added up from the ad rows —
  // reach is deduplicated people, so adding it double-counts anyone who saw
  // two ads, and that is exactly how a dashboard starts disagreeing with
  // Ads Manager.
  const campaign = await fetchCampaignInsights(campaignId, createdTime, scope);
  if (campaign) {
    const { error } = await db.from("campaign_insights").upsert(
      { ...campaign, ad_account_id: scope?.adAccountId ?? null, updated_at: new Date().toISOString() },
      { onConflict: "campaign_id" }
    );
    if (error) throw new Error(error.message);
  }

  const ads = await fetchCampaignAdInsights(campaignId, createdTime, scope);
  if (ads.length > 0) {
    const { error } = await db.from("ad_insights").upsert(
      ads.map((i) => ({ ...i, ad_account_id: scope?.adAccountId ?? null, updated_at: new Date().toISOString() })),
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
  formIds: Set<string>,
  scopes: Map<string, AccountScope>
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
      schemas.push({ ...(await fetchFormSchema(id, scopes.get(id))), updated_at: new Date().toISOString() });
    } catch (err) {
      // The dashboard falls back to machine keys for this form. Say which form
      // and why - this exact silence is how a wrong-token read hid for days.
      console.error(`[sync] form ${id} schema unreadable: ${err instanceof Error ? err.message : err}`);
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
    .select("lead_id, phone, email, status, deal_value, ad_account_id, quality_score, submitted_at, status_at, raw_fields")
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
    ad_account_id: string | null;
    quality_score: number | null;
    submitted_at: string | null;
    status_at: string | null;
    raw_fields: Record<string, unknown> | null;
  }[]) {
    // The score travels with every event: as metadata always, and as value on
    // everything except reservation, where the real deal figure wins.
    const score =
      lead.quality_score ??
      leadQualityScore({
        status: lead.status,
        submitted_at: lead.submitted_at,
        status_at: lead.status_at,
        raw_fields: lead.raw_fields,
        phone: lead.phone,
        email: lead.email,
      });
    // One shared definition — see chainFor. This used to be spelled out here
    // and it was missing the `rank >= 1` bound, so every qualified lead was
    // also reported to Meta as NoAnswer AND Disqualified.
    const chain = chainFor(lead.status);

    chain.forEach((st, i) => {
      if (missing.length >= maxEvents) return;
      if (done.has(capiEventId(lead.lead_id, st.event as string))) return;
      missing.push({
        adAccountId: lead.ad_account_id ?? null,
        leadId: lead.lead_id,
        eventName: st.event as string,
        // Now, not the submission time: "when the lead was received and
        // processed", and safely after the generation time — Meta discards
        // events timestamped before the lead existed. Spaced so the order Meta
        // reads is the order the lead walked.
        eventTime: new Date(now - (chain.length - 1 - i) * 1000),
        phone: lead.phone ?? undefined,
        email: lead.email ?? undefined,
        value: st.status === "reservation" ? lead.deal_value : score,
        qualityScore: score,
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

  // Grouped by account, because a lead's events belong in the dataset connected
  // to the account that produced it. One dataset for everything would be
  // accepted by Meta and attributed to nothing for every account but one.
  const { scopes } = await activeAccounts(db);
  const scopeIdx = scopeIndex(scopes);

  const groups = new Map<string, typeof missing>();
  const withheld: string[] = [];

  for (const ev of missing) {
    if (!ev.adAccountId) {
      // Stored before the accounts table existed and never re-synced. The
      // environment's dataset is the only account it could have come from.
      const bucket = groups.get("") ?? [];
      bucket.push(ev);
      groups.set("", bucket);
      continue;
    }

    const route = scopeIdx.get(ev.adAccountId);
    if (!route) {
      // The lead's account is disconnected, paused, or unverified. Sending
      // anyway means sending to SOME OTHER account's dataset - accepted with a
      // 200, attributed to nothing, and invisible. Held instead, and named.
      withheld.push(ev.adAccountId);
      continue;
    }

    const bucket = groups.get(ev.adAccountId) ?? [];
    bucket.push(ev);
    groups.set(ev.adAccountId, bucket);
  }

  if (withheld.length > 0) {
    console.warn(
      `[sync] stage sweep: held ${withheld.length} event(s) whose ad account is not active - ` +
        `${[...new Set(withheld)].join(", ")}. Reconnect the account to release them.`
    );
  }

  let sent = 0, attempted = 0, failed = 0;
  for (const [accountId, batch] of groups) {
    // Dataset and token come from the SAME row: the pairing Meta verified.
    const route = accountId ? scopeIdx.get(accountId) : undefined;
    const result = await sendLeadEvents(batch, 100, route?.datasetId, route?.token).catch((err) => {
      console.error("[sync] stage events failed", err);
      return { attempted: 0, sent: 0, failed: batch.length };
    });
    attempted += result.attempted; sent += result.sent; failed += result.failed;
    console.log(
      `[sync] stage events account=${accountId || "(env default)"} ` +
        `dataset=${route?.datasetId || "(env default)"} ` +
        `attempted=${result.attempted} sent=${result.sent} failed=${result.failed}`
    );
  }
  console.log(`[sync] stage events total attempted=${attempted} sent=${sent} failed=${failed}`);
  return sent;
}


/**
 * Recompute quality scores for recent leads and store what changed.
 *
 * Cheap by construction: one read, pure functions, and only rows whose score
 * actually moved get written back. Runs after the CRM mirror so a stage move
 * reprices the lead in the same sync that learned about it.
 */
async function refreshQualityScores(db: ReturnType<typeof supabaseAdmin>, limit = 400): Promise<number> {
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data: rows } = await db
    .from("leads")
    .select("lead_id, status, submitted_at, status_at, raw_fields, phone, email, quality_score")
    .gte("submitted_at", since)
    .order("submitted_at", { ascending: false })
    .limit(limit);

  if (!rows || rows.length === 0) return 0;

  const changed: { lead_id: string; score: number }[] = [];
  for (const r of rows) {
    const score = leadQualityScore({
      status: r.status as Status,
      submitted_at: r.submitted_at as string | null,
      status_at: r.status_at as string | null,
      raw_fields: r.raw_fields as Record<string, unknown> | null,
      phone: r.phone as string | null,
      email: r.email as string | null,
    });
    if (score !== r.quality_score) changed.push({ lead_id: r.lead_id as string, score });
  }

  // Individual updates, deliberately: an upsert would have to restate NOT NULL
  // columns, and a wrong restatement is worse than a few extra round-trips.
  for (let i = 0; i < changed.length; i += 10) {
    await Promise.all(
      changed.slice(i, i + 10).map((c) =>
        db.from("leads").update({ quality_score: c.score }).eq("lead_id", c.lead_id)
      )
    );
  }

  if (changed.length > 0) console.log(`[sync] quality: rescored ${changed.length}/${rows.length} lead(s)`);
  return changed.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8X CRM -> this app
// ─────────────────────────────────────────────────────────────────────────────

type CrmSyncResult = {
  skipped?: string;
  scanned: number;
  matched: number;
  changed: number;
  owners: number;
  notes: number;
  total?: number;
  coverage?: string;
  unmappedStatusIds?: string[];
  moves?: { lead_id: string; from: Status; to: Status }[];
  /** First few mirrored rows, so a sync response shows what it actually read. */
  sample?: { lead_id: string; owner: string | null; note: string | null }[];
};

const skippedResult = (why: string): CrmSyncResult =>
  ({ skipped: why, scanned: 0, matched: 0, changed: 0, owners: 0, notes: 0 });

/** How many CRM rows to pull at a time. 250 is the most the server honours. */
const CRM_PAGE = 250;
/** Leaves room for the rest of the run inside the 60s function limit. */
const CRM_BUDGET_MS = 25_000;
/** Note inserts per run — the mirror catches up over runs, never in one gulp. */
const CRM_MAX_NOTES = 200;

/**
 * Mirror the sales team's work back out of 8X CRM: the stage each lead is in,
 * the agent holding it, and the latest note written on it.
 *
 * The team works in the CRM, so the CRM decides what happened to a lead and
 * this app's only job is to agree with it. Nothing here writes to the CRM.
 *
 * MATCHING is on leadgen_id — stored verbatim from Meta, equal to our lead_id
 * on every lead present in both. Phones are the fallback that is deliberately
 * NOT taken: +20 against 0020, two relatives behind one number, and every
 * mismatch indistinguishable from a lead that was never passed on.
 *
 * NOTES arrive through v4's `last_activity`, which only carries the most
 * recent one — the full history sits behind endpoints 8X does not document.
 * So each run copies the latest note it has not seen before, and the history
 * accumulates here run by run. Dedup is by exact (lead, body): the same words
 * written twice on one lead is rare; a lost note is invisible.
 *
 * An unmapped status_id is counted and named in the log, never guessed at — a
 * lead filed under the wrong stage leaves here as optimisation signal to Meta,
 * and no screen anywhere would show it.
 */
async function syncCrmStatuses(db: ReturnType<typeof supabaseAdmin>): Promise<CrmSyncResult> {
  if (!CRM_CONFIGURED) {
    console.log("[sync] crm: skipped, CRM_API_KEY not set");
    return skippedResult("CRM_API_KEY not set");
  }

  // Two senders on one dataset means Meta trains on a double-counted funnel,
  // and no screen anywhere reports that. Worth a loud line every run.
  if (APP_SENDS_EVENTS) {
    console.warn(
      "[sync] crm: reminder — CAPI_SENDER=app, so 8X's own Meta integration must stay OFF " +
        "(Settings > Integrations > Meta Conversions API > Enable Integration)."
    );
  }

  const { data: ours, error } = await db.from("leads").select("lead_id,status,owner");
  if (error) return skippedResult(error.message);

  const mine = new Map(
    (ours ?? []).map((l) => [String(l.lead_id), { status: l.status as Status, owner: (l.owner as string | null) ?? null }])
  );
  if (mine.size === 0) {
    console.log("[sync] crm: skipped, no leads stored yet");
    return skippedResult("no leads stored yet");
  }

  const startedAt = Date.now();
  const unmapped = new Set<string>();
  const moves: { lead_id: string; from: Status; to: Status; at: string | null }[] = [];
  const patches = new Map<string, Record<string, unknown>>();
  const noteCandidates = new Map<string, { lead_id: string; body: string; author: string; at: string | null }>();
  const sample: { lead_id: string; owner: string | null; note: string | null }[] = [];
  let scanned = 0;
  let matched = 0;
  let total = 0;

  try {
    for (let start = 0; ; start += CRM_PAGE) {
      const page = await crmPage(start, CRM_PAGE);
      total = page.total;
      if (page.rows.length === 0) break;
      scanned += page.rows.length;

      for (const row of page.rows) {
        const leadId = row.leadgen_id ? String(row.leadgen_id) : null;
        if (!leadId) continue;                    // not from Meta lead ads
        const current = mine.get(leadId);
        if (current === undefined) continue;      // not a lead this app tracks
        matched++;

        const patch: Record<string, unknown> = {};

        const next = statusFromCrmStatusId(row.status_id);
        if (!next && row.status_id != null) unmapped.add(String(row.status_id));
        if (next && next !== current.status) {
          const at = typeof row.updated_at === "string" ? row.updated_at : null;
          moves.push({ lead_id: leadId, from: current.status, to: next, at });
          patch.status = next;
          patch.status_at = at ?? new Date().toISOString();
        }

        const owner = pickOwner(row);
        if (owner && owner !== current.owner) patch.owner = owner;

        const note = pickLastNote(row);
        if (note && noteCandidates.size < CRM_MAX_NOTES) {
          noteCandidates.set(`${leadId}\u0000${note.body}`, {
            lead_id: leadId,
            body: note.body,
            author: note.author ?? owner ?? "8X CRM",
            at: note.at,
          });
        }

        if (Object.keys(patch).length > 0) patches.set(leadId, patch);
        if (sample.length < 3) sample.push({ lead_id: leadId, owner, note: note ? note.body.slice(0, 60) : null });
      }

      if (scanned >= total) break;
      if (Date.now() - startedAt > CRM_BUDGET_MS) break;
    }
  } catch (err) {
    console.error(`[sync] crm: page failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  let owners = 0;
  for (const [leadId, patch] of patches) {
    const { error: upErr } = await db.from("leads").update(patch).eq("lead_id", leadId);
    if (!upErr && "owner" in patch) owners++;
  }

  if (moves.length > 0) {
    // The timeline reads as one stream, so a stage that moved by itself is not
    // a mystery to whoever opens the lead later.
    await db.from("lead_notes").insert(
      moves.map((m) => ({
        lead_id: m.lead_id, kind: "stage", from_status: m.from, to_status: m.to,
        author: "8X CRM", body: null,
      }))
    );
  }

  // Insert only the notes we have not mirrored before.
  let notesAdded = 0;
  if (noteCandidates.size > 0) {
    const ids = [...new Set([...noteCandidates.values()].map((n) => n.lead_id))];
    const { data: existing } = await db
      .from("lead_notes").select("lead_id,body").eq("kind", "note").in("lead_id", ids);
    const seen = new Set((existing ?? []).map((n) => `${n.lead_id}\u0000${(n.body as string | null) ?? ""}`));
    const fresh = [...noteCandidates.entries()]
      .filter(([key]) => !seen.has(key))
      .map(([, n]) => ({
        lead_id: n.lead_id, kind: "note", body: n.body, author: n.author,
        ...(n.at ? { created_at: n.at } : {}),
      }));
    if (fresh.length > 0) {
      const { error: noteErr } = await db.from("lead_notes").insert(fresh);
      if (noteErr) console.error(`[sync] crm: note insert failed — ${noteErr.message}`);
      else notesAdded = fresh.length;
    }
  }

  if (unmapped.size > 0) {
    console.warn(`[sync] crm: ${unmapped.size} unknown status_id(s): ${[...unmapped].join(", ")} — add them to STATUS_ID_TO_STAGE`);
  }
  const unknownUsers = drainUnknownUserIds();
  if (unknownUsers.length > 0) {
    console.warn(`[sync] crm: unknown user id(s): ${unknownUsers.join(", ")} — likely suspended agents; add to CRM_USER_TO_NAME`);
  }
  console.log(
    `[sync] crm: scanned=${scanned}/${total} matched=${matched} moved=${moves.length} owners=${owners} notes=${notesAdded}` +
      (unmapped.size ? ` unmapped=${[...unmapped].join(",")}` : "")
  );

  const result: CrmSyncResult = {
    scanned, matched, total,
    changed: moves.length,
    owners,
    notes: notesAdded,
    coverage: total > 0 ? Math.round((1000 * scanned) / total) / 10 + "%" : undefined,
    unmappedStatusIds: unmapped.size ? [...unmapped] : undefined,
    moves: moves.slice(0, 25).map(({ lead_id, from, to }) => ({ lead_id, from, to })),
    sample,
  };

  // The health panel reads this back; a sync that never runs shows as absent.
  await db.from("app_settings").upsert(
    { key: "last_crm_sync", value: { at: new Date().toISOString(), ...result, moves: undefined, sample: undefined }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );

  return result;
}
