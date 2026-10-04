import { NextRequest, NextResponse } from "next/server";
import {
  listCampaigns,
  listCampaignAds,
  fetchAdLeads,
  listLeadForms,
  fetchCampaignAdInsights,
  fetchCampaignInsights,
  fetchFormSchema,
  normalizeEgyptPhone,
  type AccountScope,
  type FormSchema,
} from "@/lib/meta";
import { activeAccounts, scopeIndex } from "@/lib/accounts";
import { leadRow } from "@/lib/ingest";
import { agentsSchemaReady } from "@/lib/schema";
import { routePending, routedCampaignIds, CRM_HOLD_MS } from "@/lib/routing";
import { resolveCampaigns } from "@/lib/tracking";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { capiEventId, sendLeadEvents } from "@/lib/capi";
import { chainFor, type Status } from "@/lib/stages";
import { leadQualityScore } from "@/lib/quality";
import { answerLabel, buildDictionary, questionLabel } from "@/lib/labels";
import { renewExpiringTokens } from "@/lib/oauth";
import { APP_SENDS_EVENTS, SENDER } from "@/lib/sender";
import {
  CRM_CONFIGURED,
  crmPage,
  crmSearchByPhone,
  crmStoreLead,
  drainUnknownUserIds,
  pickAssignments,
  pickCreatedAt,
  pickLastActivity,
  pickLastNote,
  pickOwner,
  pickPhone,
  statusFromCrmStatusId,
} from "@/lib/crm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Re-reads a slice of history on every run so a lead that arrives out of order
 * (or lands while a sync is mid-flight) is not skipped forever. Cheap, because
 * `ignoreDuplicates` makes re-reading a no-op at the database.
 */
const OVERLAP_MS = 2 * 60 * 60 * 1000;

/**
 * The whole run's time, shared by every step. maxDuration is 60s and Vercel
 * kills the function at that mark mid-write, so the run stops STARTING work
 * well before it. Before this existed, 85% of runs in a day were killed, and
 * because the steps ran in a fixed order the ones at the end - the CRM mirror
 * and the Meta stage events - were the ones that starved.
 *
 * So the order is by what can wait, not by what feeds what:
 *   1. the 8X mirror       - stages, owners, the speed-to-lead log (8X + DB only)
 *   2. quality + stage events to Meta - the optimisation signal
 *   3. new leads from Meta - Graph is the slow, erratic part; a lead missed
 *      here is re-read next run through the 2h overlap window
 *   4. CRM push, spend, form wording - with whatever time is left
 * A lead read in step 3 reaches steps 1-2 on the next run, ten minutes later;
 * Meta accepts stage events for seven days.
 */
const RUN_BUDGET_MS = 54_000;

/**
 * Resolve with `fallback` if `p` has not settled in `ms`. The step keeps
 * running in the background, but the run moves on - one stuck dependency
 * must never take every other step down with it.
 */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), Math.max(0, ms));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
/** Never START reading a campaign's leads with less than this left. */
const LEADS_MIN_LEFT_MS = 12_000;

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
  const runStart = Date.now();
  const remaining = () => RUN_BUDGET_MS - (Date.now() - runStart);
  const deferred: string[] = [];

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
    const phase: Record<string, number> = {};
    let lap = Date.now();
    const done = (name: string) => {
      phase[name] = Date.now() - lap;
      lap = Date.now();
    };

    // 1. What the sales team actually did, read back out of 8X CRM. This is
    // the only thing that fills `status`; nobody types stages into this app.
    //
    // Every run reads the newest pages (new leads, first touches - what the
    // speed-to-lead clock needs); once an hour, and on the first run with an
    // empty assignment log, it walks as deep as its budget allows so stage
    // moves on older leads are mirrored too.
    const { count: assignmentsLogged } = await db
      .from("lead_assignments")
      .select("lead_id", { count: "exact", head: true });
    const deep =
      req.nextUrl.searchParams.get("crm") === "deep" ||
      new Date().getUTCMinutes() < 10 ||
      (assignmentsLogged ?? 0) === 0;
    const crmBudget = 16_000;
    const lookupBudget = 6_000;
    const crmCeiling = crmBudget + lookupBudget + 6_000;
    // The page reads and look-ups inside are bounded by their budgets; the
    // database writes after them are not, so the whole step gets a hard
    // ceiling as well.
    crm = await withDeadline(
      syncCrmStatuses(db, { deep, budgetMs: crmBudget, lookupMs: lookupBudget }),
      crmCeiling,
      () => {
        console.error(`[sync] crm: gave up after ${crmCeiling / 1000}s - 8X or the database is stuck; the rest of the run carries on`);
        return skippedResult("timed out");
      }
    );
    done("crm");

    // 2. Quality scores follow every stage move the mirror just brought in,
    // then every stage each lead has reached goes to Meta if it never did.
    await refreshQualityScores(db);
    stageEvents = await sendMissingStageEvents(db);
    done("capi");

    // Once an hour on the sync that lands in the first ten-minute slot: renew
    // any Facebook Login token inside its warning window. This is the only
    // schedule the deployment guarantees, so the renewal lives on it.
    if (new Date().getUTCMinutes() < 10) {
      const t = await renewExpiringTokens();
      if (t.checked > 0) console.log(`[sync] tokens: checked=${t.checked} renewed=${t.refreshed} declined=${t.failed}`);
      done("tokens");
    }

    // 3. New leads from Meta.
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
      if (remaining() < LEADS_MIN_LEFT_MS) {
        deferred.push(`(account ${acc.name || acc.adAccountId})`);
        continue;
      }
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
    // Names already stored first - the Page-wide form listing is one of the
    // slowest Graph reads in the run, so it only happens with time to spare.
    {
      const { data: known } = await db.from("lead_forms").select("form_id,name");
      for (const f of (known ?? []) as { form_id: string; name: string | null }[]) {
        if (f.name) formNames.set(String(f.form_id), f.name);
      }
    }
    for (const acc of tracked.length > 0 && remaining() > 30_000 ? accounts : []) {
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

    // Insights are read AFTER the CRM mirror and the stage events, with the
    // time that is left - spend going stale for ten minutes is harmless,
    // stage feedback not reaching Meta is not.
    const insightJobs: { campaign: (typeof tracked)[number]; scope: AccountScope; entry: { spend?: number } }[] = [];

    // Rotated each run, so when the budget cuts the list short it is never
    // the same campaigns that wait.
    const turn = tracked.length ? Math.floor(runStart / 600_000) % tracked.length : 0;
    const ordered = [...tracked.slice(turn), ...tracked.slice(0, turn)];

    for (const campaign of ordered) {
      if (remaining() < LEADS_MIN_LEFT_MS) {
        deferred.push(campaign.name);
        continue;
      }
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

          for (const lead of raw) rows.push(leadRow(lead, ad, campaign, scope, formNames));
        }

        leadsFound += found;
        for (const r of rows)
          if (r.form_id) {
            formIdsSeen.add(String(r.form_id));
            if (!formScopes.has(String(r.form_id))) formScopes.set(String(r.form_id), scope);
          }

        if (rows.length === 0) {
          const entry = { campaign: campaign.name, ads: ads.length, found: 0, inserted: 0 } as (typeof perCampaign)[number];
          perCampaign.push(entry);
          insightJobs.push({ campaign, scope, entry });
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

        const entry = { campaign: campaign.name, ads: ads.length, found, inserted: n } as (typeof perCampaign)[number];
        perCampaign.push(entry);
        insightJobs.push({ campaign, scope, entry });
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

    done("leads");
    if (deferred.length > 0) {
      console.warn(`[sync] run budget: ${deferred.length} campaign(s) wait for the next run: ${deferred.join(" | ")}`);
    }

    // Routed campaigns' new leads go to their agents BEFORE the 8X push below
    // runs, so a lead this app hands to an agent is never also sent to 8X.
    // The one-minute agent tick does the same faster; this is the net under it.
    const routing = await routePending(db).catch((err) => {
      console.error(`[sync] routing failed: ${err instanceof Error ? err.message : err}`);
      return { routed: 0, waiting: 0 };
    });
    done("routing");

    // Hand the sales team the leads they cannot otherwise see. Only accounts
    // explicitly opted in (ad_accounts.crm_push) are pushed - the original
    // account's leads already arrive in 8X through its own Facebook
    // integration, and pushing those would create a second copy of every one.
    const crmPushed = await pushLeadsToCrm(db, 25, Math.min(10_000, remaining() - 7_000));
    done("push");

    // Spend and delivery, with whatever time is left.
    let insightsSkipped = 0;
    for (const job of insightJobs) {
      if (remaining() < 8_000) { insightsSkipped++; continue; }
      job.entry.spend = await refreshInsights(db, job.campaign.id, job.campaign.created_time, job.scope).then(
        (r) => {
          insightsRows += r.rows;
          return r.spend;
        },
        (err) => {
          // Spend staying stale is tolerable; not knowing it went stale is
          // not. Same lesson as the lead reads: name the failure.
          console.error(
            `[sync] insights for "${job.campaign.name}" failed: ${err instanceof Error ? err.message : err}`
          );
          return undefined;
        }
      );
    }
    if (insightsSkipped > 0) console.warn(`[sync] run budget: insights for ${insightsSkipped} campaign(s) wait for the next run`);
    done("insights");

    // The wording of each form — what the customer actually read — so the
    // dashboard can show the Arabic question and answer instead of Meta's keys.
    const formsStored = remaining() > 6_000 ? await refreshFormSchemas(db, formIdsSeen, formScopes) : 0;
    done("forms");

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
        `insights=${insightsRows} forms=${formsStored} routed=${routing.routed} ` +
        `crmPush=${crmPushed.pushed}/${crmPushed.pushed + crmPushed.failed}${crmPushed.left ? ` (+${crmPushed.left} queued)` : ""} ` +
        `crm=${crm.skipped ?? `${crm.matched}/${crm.scanned} matched, ${crm.changed} moved, ${crm.owners} owners, ${crm.notes} notes`}` +
        ` took=${Date.now() - runStart}ms (` +
        Object.entries(phase).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(" ") + ")"
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
      routing,
      crmPushed,
      crm,
      deferred,
      tookMs: Date.now() - runStart,
      phaseMs: phase,
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
  // At most 20 per run. A Page can carry years of old forms (one of ours has
  // ~80), and each schema is its own Graph call - fetching them all in one go
  // once a week would eat a third of the function's 60s budget. The stale set
  // just drains across consecutive ten-minute runs instead.
  const stale = [...formIds].filter((id) => !known.has(id)).slice(0, 20);
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

/** 8X refuses anything longer outright, so the text is trimmed, not lost. */
const CRM_DESCRIPTION_MAX = 190;

function fitDescription(lines: string[]): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = (out.length ? 1 : 0) + line.length;
    if (used + cost > CRM_DESCRIPTION_MAX) {
      // Half a sentence beats no sentence when it is the only line there is.
      if (out.length === 0) return line.slice(0, CRM_DESCRIPTION_MAX - 1) + "\u2026";
      break;
    }
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}

/**
 * Send leads the CRM has never seen into 8X, so somebody actually calls them.
 *
 * Scoped by ad_accounts.crm_push, which is opt-in per account and false by
 * default. That flag is the whole safety mechanism: the first account's leads
 * reach 8X through its own Facebook Lead Ads integration, so pushing them here
 * would duplicate every single one, and a duplicate lead is worse than a
 * missing one - two agents call the same person.
 *
 * Bounded per run so a backlog drains over consecutive syncs instead of
 * blowing the function's 60s budget. crm_pushed_at is stamped per lead the
 * moment the CRM accepts it, so a run that dies halfway never re-sends what it
 * already sent.
 */
async function pushLeadsToCrm(
  db: ReturnType<typeof supabaseAdmin>,
  limit = 25,
  budgetMs = 15_000
): Promise<{ pushed: number; failed: number; left: number; skipped?: string }> {
  if (!CRM_CONFIGURED) return { pushed: 0, failed: 0, left: 0, skipped: "CRM_API_KEY not set" };
  if (budgetMs < 2_000) return { pushed: 0, failed: 0, left: 0, skipped: "no time left this run" };

  const { data: optedIn } = await db
    .from("ad_accounts")
    .select("ad_account_id,name")
    .eq("crm_push", true)
    .eq("enabled", true);

  if (!optedIn || optedIn.length === 0) return { pushed: 0, failed: 0, left: 0 };
  const ids = optedIn.map((a) => String(a.ad_account_id));

  let dueQuery = db
    .from("leads")
    .select("lead_id,full_name,phone,email,form_id,raw_fields,campaign_id,campaign_name,ad_name,submitted_at,crm_push_error")
    .in("ad_account_id", ids)
    .is("crm_pushed_at", null)
    .not("phone", "is", null)
    .order("submitted_at", { ascending: true })
    .limit(limit + 1);
  // A lead handed to an agent in this app is that agent's. Pushing it to 8X
  // as well puts a second person on the same phone call; a test lead is
  // nobody at all. (Only once migration 0015 has run - lib/schema.ts.)
  if (await agentsSchemaReady(db)) dueQuery = dueQuery.is("agent_id", null).eq("is_test", false);
  const { data: due, error } = await dueQuery;

  if (error) {
    console.error(`[sync] crm push: cannot read the queue - ${error.message}`);
    return { pushed: 0, failed: 0, left: 0, skipped: error.message };
  }

  const rows = (due ?? []) as unknown as {
    lead_id: string;
    full_name: string | null;
    phone: string | null;
    email: string | null;
    form_id: string | null;
    raw_fields: Record<string, string> | null;
    campaign_id: string | null;
    campaign_name: string | null;
    ad_name: string | null;
    submitted_at: string;
    crm_push_error: string | null;
  }[];
  if (rows.length === 0) return { pushed: 0, failed: 0, left: 0 };

  // A routed campaign's lead with no agent yet is waiting for the minute tick,
  // not abandoned. Only once it has waited past the hold - nobody eligible in
  // the rule - does 8X become the fallback that gets it called at all.
  const routed = await routedCampaignIds(db);
  const held = (r: (typeof rows)[number]) =>
    !!r.campaign_id && routed.has(r.campaign_id) && Date.now() - Date.parse(r.submitted_at) < CRM_HOLD_MS;

  // A 4xx is a verdict on the payload, not a hiccup: the same body will be
  // refused again forever. Retrying it every ten minutes is how thirteen leads
  // ate a slice of every sync for nothing - and it is unstamped rows like
  // these that pushed the run into the 60s ceiling. 429 is the exception: it
  // means "later", not "no". The over-long description is the other one:
  // fitDescription() below is the cure, so the leads refused for it before
  // this deploy get exactly one more try instead of being parked for good.
  const permanentlyRefused = (e: string | null) =>
    !!e && /^HTTP 4/.test(e) && !/^HTTP 429/.test(e) &&
    !/description may not be greater/.test(e);

  const live = rows.filter((r) => !permanentlyRefused(r.crm_push_error) && !held(r));
  const stuck = rows.filter((r) => permanentlyRefused(r.crm_push_error)).length;
  if (stuck > 0) console.warn(`[sync] crm push: ${stuck} lead(s) parked on a permanent refusal`);

  const batch = live.slice(0, limit);
  const left = live.length > limit ? live.length - limit : 0;

  // The question wording, so the agent opening the lead reads what the
  // customer read - not payment_plan: plan_0_6.
  const formIds = [...new Set(batch.map((r) => r.form_id).filter((v): v is string => Boolean(v)))];
  const { data: formRows } = formIds.length
    ? await db.from("lead_forms").select("form_id, name, locale, questions").in("form_id", formIds)
    : { data: [] };
  const dict = buildDictionary((formRows ?? []) as unknown as FormSchema[]);

  let pushed = 0;
  let failed = 0;
  const pushStarted = Date.now();

  for (const lead of batch) {
    // The whole sync shares one 60s budget, and this loop is HTTP call after
    // HTTP call. Overrunning it does not just cut the push short - it kills
    // the function before the CRM mirror ever runs, which is how one slow
    // batch silenced stage feedback entirely. Whatever is left stays queued
    // for the next run ten minutes later.
    if (Date.now() - pushStarted > budgetMs) break;

    // 8X caps this column at 191 characters and answers a longer one with a
    // hard 422 - which is what refused every single push until the log said
    // so. The customer's own answers go FIRST, so when the budget runs out it
    // is the campaign name that falls off the end, never the thing the agent
    // needs to read before dialling.
    const answers: string[] = [];
    for (const [key, value] of Object.entries(lead.raw_fields ?? {})) {
      if (!value?.trim()) continue;
      if (/^(full_name|phone|email)$/i.test(key)) continue;   // already on the record
      answers.push(`${questionLabel(dict, key)}: ${answerLabel(dict, key, value)}`);
    }
    const lines = [...answers, lead.campaign_name, lead.ad_name].filter(Boolean) as string[];

    let result;
    try {
      result = await crmStoreLead(
        {
          fullName: lead.full_name,
          phone: lead.phone,
          email: lead.email,
          formId: lead.form_id,
          description: fitDescription(lines),
        },
        // Never longer than what is left of this step's budget.
        Math.min(15_000, Math.max(2_000, budgetMs - (Date.now() - pushStarted)))
      );
    } catch (err) {
      result = { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      pushed++;
      await db
        .from("leads")
        .update({ crm_pushed_at: new Date().toISOString(), crm_push_error: null })
        .eq("lead_id", lead.lead_id);
    } else {
      failed++;
      // Left unstamped on purpose: the next run retries it. The error is kept
      // on the row so a permanent refusal is visible instead of looking like a
      // lead that simply has not had its turn yet.
      await db
        .from("leads")
        .update({ crm_push_error: `HTTP ${result.status}: ${result.body}`.slice(0, 400) })
        .eq("lead_id", lead.lead_id);
      if (failed <= 2) {
        console.error(`[sync] crm push: lead ${lead.lead_id} refused - HTTP ${result.status} ${result.body}`);
      }
    }
  }

  const leftNow = left + (batch.length - pushed - failed);
  console.log(`[sync] crm push: sent=${pushed} refused=${failed} queued=${leftNow}`);
  return { pushed, failed, left: leftNow };
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

  let recentQuery = db
    .from("leads")
    .select("lead_id, phone, email, status, deal_value, ad_account_id, quality_score, submitted_at, status_at, raw_fields")
    .gte("submitted_at", sevenDaysAgo)
    .order("submitted_at", { ascending: false })
    .limit(limit);
  // Test leads are pretend customers; Meta must never hear of them.
  if (await agentsSchemaReady(db)) recentQuery = recentQuery.eq("is_test", false);
  const { data: recent, error: leadErr } = await recentQuery;

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
/**
 * An ordinary run reads ONE page of the newest rows - about two weeks of
 * leads, which covers every lead Meta will still take a stage event for
 * (seven days) and every clock still running. 8X answers a 250-row page in
 * 10-20s on a bad afternoon, so the page is kept small.
 */
const CRM_FAST_LENGTH = 120;
/** Phone look-ups per run for leads the pages did not find (returning people). */
const CRM_LOOKUPS = 4;
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
async function syncCrmStatuses(
  db: ReturnType<typeof supabaseAdmin>,
  opts: { deep: boolean; budgetMs: number; lookupMs: number }
): Promise<CrmSyncResult> {
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

  if (opts.budgetMs < 3_000) {
    console.warn("[sync] crm: skipped, no time left this run");
    return skippedResult("no time left this run");
  }
  const CRM_BUDGET_MS = opts.budgetMs;

  // Accounts kept out of 8X entirely (ad_accounts.crm_sync = false). Their
  // leads are worked in this app only, so the mirror must never touch them:
  // a phone match against an unrelated 8X record would otherwise overwrite
  // the stage the team set here and stamp an 8X agent as the owner.
  const { data: noCrm } = await db.from("ad_accounts").select("ad_account_id").eq("crm_sync", false);
  const crmExcluded = new Set((noCrm ?? []).map((a) => String(a.ad_account_id)));

  const agentsReady = await agentsSchemaReady(db);
  let oursQuery = db
    .from("leads")
    .select(
      "lead_id,status,owner,phone,crm_created_at,submitted_at,crm_returning_since,crm_lookup_at,crm_pushed_at,ad_account_id" +
        (agentsReady ? ",agent_id" : "")
    );
  if (agentsReady) oursQuery = oursQuery.eq("is_test", false);
  const { data: allOurs, error } = await oursQuery;
  if (error) return skippedResult(error.message);
  // The same goes for a single lead handed to an agent in the agent app: its
  // stage is what that agent picked after the call, and 8X must not overwrite
  // it. To the mirror, neither kind of lead exists (nor do test leads).
  // The column list is built at runtime (agent_id only once 0015 has run), so
  // the row type is stated rather than inferred.
  type MirrorRow = {
    lead_id: string; status: string; owner: string | null; phone: string | null;
    crm_created_at: string | null; submitted_at: string; crm_returning_since: string | null;
    crm_lookup_at: string | null; crm_pushed_at: string | null; ad_account_id: string | null;
    agent_id?: string | null;
  };
  const ours = ((allOurs ?? []) as unknown as MirrorRow[]).filter(
    (row) => !crmExcluded.has(String(row.ad_account_id ?? "")) && !row.agent_id
  );
  type Ours = {
    lead_id: string; phone: string | null; owner: string | null; submitted_at: string;
    crm_created_at: string | null; crm_returning_since: string | null; crm_lookup_at: string | null;
    crm_pushed_at: string | null;
  };
  const leadInfo = new Map(((ours ?? []) as unknown as Ours[]).map((l) => [String(l.lead_id), l]));
  const seenThisRun = new Set<string>();
  const noCrmCreated = new Set(
    (ours ?? []).filter((l) => !(l as { crm_created_at?: string | null }).crm_created_at).map((l) => String(l.lead_id))
  );

  const mine = new Map(
    (ours ?? []).map((l) => [String(l.lead_id), { status: l.status as Status, owner: (l.owner as string | null) ?? null }])
  );

  // The second way in. A lead this app pushed into 8X carries no leadgen_id -
  // the CRM's create endpoint has no field for one - so its stage changes
  // would come back joined to nothing at all. The phone is the only identifier
  // both sides hold, normalised here to the same form on both.
  //
  // A number that belongs to more than one lead is dropped rather than guessed
  // at: writing the wrong lead's stage is worse than writing none, because
  // nothing downstream looks wrong afterwards.
  const byPhone = new Map<string, { leadId: string; status: Status; owner: string | null }>();
  const ambiguous = new Set<string>();
  for (const l of ours ?? []) {
    const p = normalizeEgyptPhone((l as { phone?: string | null }).phone ?? undefined);
    if (!p) continue;
    if (byPhone.has(p)) { ambiguous.add(p); continue; }
    byPhone.set(p, {
      leadId: String(l.lead_id),
      status: l.status as Status,
      owner: (l.owner as string | null) ?? null,
    });
  }
  for (const p of ambiguous) byPhone.delete(p);
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
  // The raw material for speed-to-lead: who holds each lead and since when,
  // every activity with its real author and time, and when the lead landed.
  const assignmentRows = new Map<string, { lead_id: string; user_id: number; user_name: string; assigned_at: string }>();
  const activityRows = new Map<string, {
    lead_id: string; kind: "activity" | "stage"; at: string; actor: string;
    actor_id: number | null; has_note: boolean; to_status: string | null;
  }>();
  const createdAt: { lead_id: string; at: string }[] = [];
  let scanned = 0;
  let matched = 0;
  let matchedByPhone = 0;
  let total = 0;
  // Field NAMES (never values) of one row that has no leadgen_id - the shape
  // of a manually created lead. Logged only when phone-matching found nothing,
  // so a wrong guess about where 8X keeps the number diagnoses itself from
  // the next run's log instead of staying invisible.
  let manualRowKeys: string | null = null;

  /**
   * `askedFor` is set when the row came back from a phone look-up for one
   * particular lead. The record 8X returns is then the one it folded that
   * lead's form into - but it carries the ORIGINAL form's leadgen_id, so left
   * to itself the row would only ever update the original lead. Maged Hanna
   * filled the ASL form on 26 Sep; 8X put it into his August record, and the
   * look-up found that record and credited it to August.
   */
  const handleRow = (row: Record<string, unknown>, askedFor?: string) => {
        let leadId = row.leadgen_id ? String(row.leadgen_id) : null;
        let current = leadId ? mine.get(leadId) : undefined;
        if (askedFor) {
          if (leadId === askedFor) return;              // its own record: handled already
          leadId = askedFor;
          current = mine.get(askedFor);
        }

        if (!row.leadgen_id && manualRowKeys === null) {
          manualRowKeys = Object.keys(row).slice(0, 40).join(",");
        }

        if (current === undefined && !askedFor) {
          const hit = byPhone.get(normalizeEgyptPhone(pickPhone(row) ?? undefined) ?? "");
          if (hit) {
            leadId = hit.leadId;
            current = { status: hit.status, owner: hit.owner };
            matchedByPhone++;
          }
        }

        if (!leadId || current === undefined) return;  // not a lead this app tracks

        const patch: Record<string, unknown> = {};
        const info = leadInfo.get(leadId);
        const submitted = info ? Date.parse(info.submitted_at) : NaN;

        // A RETURNING person: the 8X record predates this form by more than a
        // day and is not this submission (no matching leadgen_id). 8X's
        // duplicate check folded the new form into the old record - no new
        // lead, and for cold-call data no re-assignment and no alert. The
        // record's stage and history belong to the old conversation, so none
        // of it is imported as if it answered this one.
        const rowCreatedAt = pickCreatedAt(row);
        const returning =
          !!rowCreatedAt && Number.isFinite(submitted) &&
          Date.parse(rowCreatedAt) < submitted - 24 * 3600_000 &&
          String(row.leadgen_id ?? "") !== leadId;
        // A look-up hit that is not a returning record is some other person
        // who happens to share digits with the search - never credit it.
        if (askedFor && !returning && !(rowCreatedAt && Number.isFinite(submitted) &&
            Math.abs(Date.parse(rowCreatedAt) - submitted) < 24 * 3600_000)) return;
        matched++;
        seenThisRun.add(leadId);
        if (returning && !info?.crm_returning_since) patch.crm_returning_since = rowCreatedAt;

        // Only what happened on or after this lead's arrival is about this lead.
        const sinceArrival = (at: string | null | undefined) =>
          !Number.isFinite(submitted) || (!!at && Date.parse(at) >= submitted - 10 * 60_000);

        const rawActivity = pickLastActivity(row);
        const activity = rawActivity && sinceArrival(rawActivity.at) ? rawActivity : null;
        if (activity) {
          activityRows.set(`${leadId}|activity|${activity.at}|${activity.actor}`, {
            lead_id: leadId, kind: "activity", at: activity.at, actor: activity.actor,
            actor_id: activity.actorId, has_note: activity.hasNote, to_status: null,
          });
        }

        const next = statusFromCrmStatusId(row.status_id);
        if (!next && row.status_id != null) unmapped.add(String(row.status_id));
        // On a returning record the stage is the old conversation's until
        // someone acts on it after this form arrived.
        const stageIsOurs = !returning || !!activity;
        if (next && next !== current.status && stageIsOurs) {
          const at = typeof row.updated_at === "string" ? row.updated_at : null;
          moves.push({ lead_id: leadId, from: current.status, to: next, at });
          patch.status = next;
          patch.status_at = at ?? new Date().toISOString();
          // Who moved it: 8X names nobody on a stage change, but moving a
          // stage is done from an activity, so an activity logged within a few
          // minutes of the move is the same hand. Otherwise left unnamed, and
          // the speed report credits whoever held the lead at the time.
          const moveAt = Date.parse(String(patch.status_at));
          const sameHand =
            activity && Number.isFinite(moveAt) && Math.abs(Date.parse(activity.at) - moveAt) <= 15 * 60_000;
          const actor = sameHand ? activity!.actor : "";
          const stageAt = new Date(Number.isFinite(moveAt) ? moveAt : Date.now()).toISOString();
          activityRows.set(`${leadId}|stage|${stageAt}|${actor}`, {
            lead_id: leadId, kind: "stage", at: stageAt, actor,
            actor_id: sameHand ? activity!.actorId : null, has_note: false, to_status: next,
          });
        }

        const owner = pickOwner(row);
        if (owner && owner !== current.owner) patch.owner = owner;

        for (const a of pickAssignments(row)) {
          assignmentRows.set(`${leadId}|${a.userId}|${a.at}`, {
            lead_id: leadId, user_id: a.userId, user_name: a.name, assigned_at: a.at,
          });
        }

        if (noCrmCreated.has(leadId) && !returning) {
          const c = pickCreatedAt(row);
          if (c) {
            createdAt.push({ lead_id: leadId, at: c });
            noCrmCreated.delete(leadId);
          }
        }

        const rawNote = pickLastNote(row);
        const note = rawNote && (!returning || sinceArrival(rawNote.at)) ? rawNote : null;
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
  };

  // v4 lists newest first, so the first page is where new leads and first
  // touches are, and every run reads it. A deep run (hourly) also reads two
  // more pages at a cursor that walks down the list and wraps, so older
  // leads' stage moves are mirrored a slice at a time. Walking from the top
  // for as long as the budget lasted made the hourly run the one that died:
  // three pages at a time against an 8X that answers a page in 10-20s.
  let pagesRead = 0;
  let firstPageSpan: string | null = null;
  let deepCursor: number | null = null;
  try {
    const jobs: { start: number; len: number }[] = [{ start: 0, len: CRM_FAST_LENGTH }];
    if (opts.deep) {
      const { data: cur } = await db.from("app_settings").select("value").eq("key", "crm_deep_cursor").maybeSingle();
      deepCursor = Number((cur?.value as { start?: number } | null)?.start) || CRM_FAST_LENGTH;
      jobs.push({ start: deepCursor, len: CRM_PAGE }, { start: deepCursor + CRM_PAGE, len: CRM_PAGE });
    }
    // Each read gets only what is left of the budget, so a slow 8X costs
    // this step its budget and nothing more. Settled one by one: a page that
    // fails does not throw away the ones that arrived.
    const left = Math.max(2_000, CRM_BUDGET_MS - (Date.now() - startedAt));
    const results = await Promise.allSettled(jobs.map((j) => crmPage(j.start, j.len, left)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[sync] crm: page at ${jobs[i].start} failed — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        return;
      }
      const page = r.value;
      pagesRead++;
      total = page.total || total;
      if (page.rows.length === 0) return;
      if (i === 0) {
        const f = page.rows[0], l = page.rows[page.rows.length - 1];
        firstPageSpan = `created ${String(f.created_at ?? "?")} .. ${String(l.created_at ?? "?")}`;
      }
      scanned += page.rows.length;
      for (const row of page.rows) handleRow(row);
    });
    if (deepCursor !== null && results.slice(1).some((r) => r.status === "fulfilled")) {
      let next = deepCursor + 2 * CRM_PAGE;
      if (total > 0 && next >= total) next = CRM_FAST_LENGTH;
      await db.from("app_settings").upsert(
        { key: "crm_deep_cursor", value: { start: next }, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    }
  } catch (err) {
    console.error(`[sync] crm: page read failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Leads the pages did not find: look each one up by phone. This is where a
  // returning person turns up - 8X put their new form into an old record deep
  // in the list. Newest first, a few per run, and a lead that is still not
  // found is asked about again hourly while fresh, daily after that.
  let lookedUp = 0;
  let lookupHits = 0;
  if (opts.lookupMs > 1_500) {
    const nowMs = Date.now();
    const due = ((ours ?? []) as unknown as Ours[])
      .filter((l) => {
        if (seenThisRun.has(String(l.lead_id)) || !l.phone) return false;
        if (l.owner && l.crm_created_at) return false;             // found before
        if (l.owner && l.crm_returning_since) return false;         // known returning
        const age = nowMs - Date.parse(l.submitted_at);
        if (!(age < 30 * 24 * 3600_000)) return false;
        const last = l.crm_lookup_at ? Date.parse(l.crm_lookup_at) : 0;
        return nowMs - last > (age < 3 * 24 * 3600_000 ? 3600_000 : 24 * 3600_000);
      })
      .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
      .slice(0, CRM_LOOKUPS);

    const lookStart = Date.now();
    const asked: string[] = [];
    for (const l of due) {
      const left = opts.lookupMs - (Date.now() - lookStart);
      if (left < 1_500) break;
      try {
        const rows = await crmSearchByPhone(l.phone as string, Math.min(8_000, left));
        asked.push(String(l.lead_id));
        lookedUp++;
        // Oldest first, so the most recent record is the one that sticks.
        rows.sort((a, b) => Date.parse(String(a.created_at ?? 0)) - Date.parse(String(b.created_at ?? 0)));
        for (const row of rows) {
          handleRow(row);                       // the lead it belongs to, if it is ours
          handleRow(row, String(l.lead_id));    // and the lead we asked about
        }
        if (seenThisRun.has(String(l.lead_id))) lookupHits++;
      } catch (err) {
        console.warn(`[sync] crm: phone look-up failed - ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    if (asked.length > 0) {
      await db.from("leads").update({ crm_lookup_at: new Date().toISOString() }).in("lead_id", asked);
    }
  }

  // Speed-to-lead history. Append-only and keyed on the event itself, so
  // re-reading the same lead every run adds nothing and costs one round trip.
  const chunk = <T,>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  let assignmentsNew = 0;
  let activitiesNew = 0;
  for (const part of chunk([...assignmentRows.values()])) {
    const { data, error: aErr } = await db
      .from("lead_assignments")
      .upsert(part, { onConflict: "lead_id,user_id,assigned_at", ignoreDuplicates: true })
      .select("lead_id");
    if (aErr) console.error(`[sync] crm: assignment log failed — ${aErr.message}`);
    else assignmentsNew += data?.length ?? 0;
  }
  for (const part of chunk([...activityRows.values()])) {
    const { data, error: xErr } = await db
      .from("lead_activities")
      .upsert(part, { onConflict: "lead_id,kind,at,actor", ignoreDuplicates: true })
      .select("lead_id");
    if (xErr) console.error(`[sync] crm: activity log failed — ${xErr.message}`);
    else activitiesNew += data?.length ?? 0;
  }
  if (createdAt.length > 0) {
    const { error: cErr } = await db.rpc("mirror_crm_created_at", { rows: createdAt });
    if (cErr) console.error(`[sync] crm: arrival times failed — ${cErr.message}`);
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
  if (matchedByPhone === 0 && byPhone.size > 0 && manualRowKeys) {
    console.log(`[sync] crm: phone-match found nothing; a no-leadgen row carries keys: ${manualRowKeys}`);
  }
  const unknownUsers = drainUnknownUserIds();
  if (unknownUsers.length > 0) {
    console.warn(`[sync] crm: unknown user id(s): ${unknownUsers.join(", ")} — likely suspended agents; add to CRM_USER_TO_NAME`);
  }
  console.log(
    `[sync] crm: ${opts.deep ? `deep@${deepCursor}` : "fast"} pages=${pagesRead} scanned=${scanned}/${total} matched=${matched}` +
      (matchedByPhone ? ` (${matchedByPhone} by phone)` : "") +
      ` moved=${moves.length} owners=${owners} notes=${notesAdded}` +
      ` assignments+${assignmentsNew} activities+${activitiesNew} arrivals+${createdAt.length}` +
      ` lookups=${lookupHits}/${lookedUp}` +
      (unmapped.size ? ` unmapped=${[...unmapped].join(",")}` : "") +
      (firstPageSpan ? ` first-page ${firstPageSpan}` : "")
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
