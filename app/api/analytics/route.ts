import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { FUNNEL, STAGE_BY_STATUS, rankOf, type Status } from "@/lib/stages";
import { answerLabel, buildDictionary, questionLabel } from "@/lib/labels";
import type { FormSchema } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type LeadRow = {
  lead_id: string;
  status: Status;
  submitted_at: string;
  status_at: string | null;
  deal_value: number | null;
  ad_id: string | null;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  platform: string | null;
  raw_fields: Record<string, string> | null;
};

type CampaignInsightRow = {
  campaign_id: string;
  campaign_name: string | null;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  meta_leads: number;
  cost_per_lead: number | null;
  currency: string | null;
  date_start: string | null;
  date_stop: string | null;
};

/** A form answer is only worth charting if it repeats — free text never does. */
const MAX_DISTINCT_ANSWERS = 12;
const MIN_ROWS_PER_ANSWER = 2;
/** Identity fields are not segments. */
const SKIP_FIELDS = /name|phone|email|whatsapp|رقم|الاسم|بريد|واتس/i;

const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
const money = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const campaign = req.nextUrl.searchParams.get("campaign");
  const scoped = campaign && campaign !== "all" ? campaign : null;

  let leadQuery = db
    .from("leads")
    .select(
      "lead_id,status,submitted_at,status_at,deal_value,ad_id,ad_name,campaign_id,campaign_name,platform,raw_fields,quality_score"
    )
    .order("submitted_at", { ascending: false })
    .limit(5000);
  if (scoped) leadQuery = leadQuery.eq("campaign_id", scoped);

  let adQuery = db.from("ad_performance").select("*");
  if (scoped) adQuery = adQuery.eq("campaign_id", scoped);

  let ciQuery = db.from("campaign_insights").select("*");
  if (scoped) ciQuery = ciQuery.eq("campaign_id", scoped);

  const [{ data: leadsRaw, error: leadErr }, { data: adsRaw, error: adErr }, { data: formRows }, { data: ciRaw }] =
    await Promise.all([
      leadQuery,
      adQuery,
      db.from("lead_forms").select("form_id, name, locale, questions"),
      ciQuery,
    ]);

  const dict = buildDictionary((formRows ?? []) as unknown as FormSchema[]);

  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });
  if (adErr) return NextResponse.json({ error: adErr.message }, { status: 500 });

  const leads = (leadsRaw ?? []) as LeadRow[];
  const ads = (adsRaw ?? []) as Record<string, number | string | null>[];

  // Average quality score per ad, folded into the ad rows. The stage columns
  // already say which creative FILLS forms; the score says which creative
  // brings leads worth calling - two different questions about the same ad.
  {
    const perAd = new Map<string, { sum: number; n: number }>();
    for (const l of leads) {
      const adId = l.ad_id as string | null;
      const q = (l as { quality_score?: number | null }).quality_score;
      if (!adId || q == null) continue;
      const cur = perAd.get(adId) ?? { sum: 0, n: 0 };
      cur.sum += q;
      cur.n += 1;
      perAd.set(adId, cur);
    }
    for (const row of ads) {
      const hit = perAd.get(String(row.ad_id ?? ""));
      row.avg_quality = hit ? Math.round(hit.sum / hit.n) : null;
    }
  }
  const ci = (ciRaw ?? []) as CampaignInsightRow[];

  // ── Delivery and money: Meta's own numbers, not ours ─────────────────────
  //
  // These are read straight out of what Meta reported at campaign level. The
  // one thing that must never be added up is REACH: it counts people, and Meta
  // has already deduplicated anyone who saw more than one ad. Adding two
  // campaigns' reach counts the overlap twice, so with more than one campaign
  // in scope we return null rather than a number that looks right and is not.
  //
  // Spend, impressions and clicks are events, so they add. CTR, CPC and CPM
  // are ratios of those, so recomputing them from the sums is exact.
  const sum = (k: keyof CampaignInsightRow) => ci.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);

  const single = ci.length === 1 ? ci[0] : null;
  const spend = money(sum("spend"));
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const linkClicks = sum("link_clicks");
  const metaLeads = sum("meta_leads");
  const currency = ci.find((r) => r.currency)?.currency ?? "EGP";

  // With more than one ad account, spend can arrive in more than one currency.
  // Adding those is meaningless, so the fact is reported rather than hidden:
  // the totals still add (they have to add to something), and the dashboard
  // says out loud that they are mixed instead of printing a confident number.
  const currencies = [...new Set(ci.map((r) => r.currency).filter(Boolean))] as string[];
  const mixedCurrency = currencies.length > 1;

  const meta = {
    spend,
    impressions,
    clicks,
    link_clicks: linkClicks,
    // Deduplicated people — only trustworthy for a single campaign.
    reach: single ? Number(single.reach) : null,
    frequency: single ? Number(single.frequency) : null,
    reach_exact: ci.length <= 1,
    ctr: impressions ? Math.round((10000 * clicks) / impressions) / 100 : null,
    cpc: clicks ? money(spend / clicks) : null,
    cpm: impressions ? money((spend / impressions) * 1000) : null,
    leads: metaLeads,
    cost_per_lead: metaLeads ? money(spend / metaLeads) : null,
    currency,
    // Meta's reporting lags — showing the window it covers is what stops this
    // looking like a bug when the CRM already has leads Meta has not counted.
    date_start: ci.map((r) => r.date_start).filter(Boolean).sort()[0] ?? null,
    date_stop: ci.map((r) => r.date_stop).filter(Boolean).sort().reverse()[0] ?? null,
    campaigns: ci.length,
  };

  const reach = meta.reach ?? 0;

  // ── Funnel ───────────────────────────────────────────────────────────────
  // Cumulative by rank: a lead sitting at "Reservation" has passed every stage
  // before it, so each step counts everyone at or beyond it.
  const reachedCount = (stage: Status) => {
    const need = rankOf(stage);
    return leads.filter((l) => rankOf(l.status) >= need && rankOf(l.status) > 0).length;
  };

  const total = leads.length;
  const funnel = [
    { status: "lead" as const, label: "Leads", count: total, fromPrev: null as number | null, ofTotal: 100 },
    ...FUNNEL.map((s) => ({ status: s, label: STAGE_BY_STATUS[s].label, count: reachedCount(s) })),
  ].map((step, i, all) => {
    const prev = i === 0 ? null : all[i - 1].count;
    return {
      ...step,
      accent: step.status === "lead" ? "#64748b" : STAGE_BY_STATUS[step.status as Status].accent,
      fromPrev: prev === null ? null : pct(step.count, prev),
      ofTotal: pct(step.count, total),
    };
  });

  // ── Current status split (where every lead is sitting right now) ──────────
  const byStatus = Object.fromEntries(
    Object.keys(STAGE_BY_STATUS).map((s) => [s, leads.filter((l) => l.status === s).length])
  ) as Record<Status, number>;

  const qualified = reachedCount("qualified");
  const siteVisits = reachedCount("site_visit_done");
  const reservations = byStatus.reservation;
  const untouched = byStatus.new;
  const reservationValue = leads
    .filter((l) => l.status === "reservation")
    .reduce((s, l) => s + Number(l.deal_value ?? 0), 0);

  // ── Speed to lead ────────────────────────────────────────────────────────
  // How long a lead sits before anyone touches it. In real estate this is the
  // single biggest lever the team itself controls.
  const touched = leads.filter((l) => l.status !== "new" && l.status_at);
  const responseHours = touched
    .map((l) => (new Date(l.status_at as string).getTime() - new Date(l.submitted_at).getTime()) / 3_600_000)
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const median = responseHours.length
    ? Math.round(responseHours[Math.floor(responseHours.length / 2)] * 10) / 10
    : null;
  const withinHour = responseHours.length ? pct(responseHours.filter((h) => h <= 1).length, responseHours.length) : null;

  // ── Daily volume ─────────────────────────────────────────────────────────
  const byDay = new Map<string, { date: string; leads: number; qualified: number; reservations: number }>();
  for (const l of leads) {
    const day = l.submitted_at.slice(0, 10);
    const row = byDay.get(day) ?? { date: day, leads: 0, qualified: 0, reservations: 0 };
    row.leads += 1;
    if (rankOf(l.status) >= 2) row.qualified += 1;
    if (l.status === "reservation") row.reservations += 1;
    byDay.set(day, row);
  }
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ── What the form answers predict ────────────────────────────────────────
  // The qualifier questions on the form are only worth asking if the answers
  // separate good leads from bad. This is the table that proves whether they do.
  const answerStats = new Map<string, Map<string, { leads: number; qualified: number; reservations: number }>>();
  for (const l of leads) {
    for (const [field, value] of Object.entries(l.raw_fields ?? {})) {
      if (SKIP_FIELDS.test(field) || !value?.trim()) continue;
      const byValue = answerStats.get(field) ?? new Map();
      const row = byValue.get(value) ?? { leads: 0, qualified: 0, reservations: 0 };
      row.leads += 1;
      if (rankOf(l.status) >= 2) row.qualified += 1;
      if (l.status === "reservation") row.reservations += 1;
      byValue.set(value, row);
      answerStats.set(field, byValue);
    }
  }

  const segments = [...answerStats.entries()]
    .filter(([, byValue]) => byValue.size > 1 && byValue.size <= MAX_DISTINCT_ANSWERS)
    .map(([field, byValue]) => ({
      field,
      // The question and answers as the customer read them — not translated,
      // just looked up. Falls back to the key when the form is unknown.
      label: questionLabel(dict, field),
      values: [...byValue.entries()]
        .filter(([, r]) => r.leads >= MIN_ROWS_PER_ANSWER)
        .map(([value, r]) => ({
          value,
          label: answerLabel(dict, field, value),
          leads: r.leads,
          qualified: r.qualified,
          reservations: r.reservations,
          qualified_pct: pct(r.qualified, r.leads),
        }))
        .sort((a, b) => b.leads - a.leads),
    }))
    .filter((s) => s.values.length > 1)
    .sort((a, b) => b.values.length - a.values.length);

  // ── Platform split ───────────────────────────────────────────────────────
  const platforms = [...new Set(leads.map((l) => l.platform).filter(Boolean))].map((p) => {
    const rows = leads.filter((l) => l.platform === p);
    return {
      platform: p as string,
      leads: rows.length,
      qualified: rows.filter((l) => rankOf(l.status) >= 2).length,
      qualified_pct: pct(rows.filter((l) => rankOf(l.status) >= 2).length, rows.length),
    };
  });

  const campaigns = [...new Map(leads.filter((l) => l.campaign_id).map((l) => [l.campaign_id, l.campaign_name])).entries()].map(
    ([id, name]) => ({ id: id as string, name: name as string })
  );

  // ── Campaigns side by side ───────────────────────────────────────────────
  // Only when the whole account is in scope — inside one campaign the board
  // would just repeat the headline numbers. Each row is one campaign measured
  // with the same yardstick: Meta's own spend, our pipeline's outcomes.
  // Campaigns appear whether they came from insights (spend but no leads yet)
  // or from leads (leads but insights not refreshed yet) — a campaign missing
  // from one source must not vanish from the board.
  let campaignBoard: Record<string, unknown>[] | null = null;
  if (!scoped) {
    const ids = new Set<string>([
      ...ci.map((r) => r.campaign_id),
      ...leads.map((l) => l.campaign_id).filter((v): v is string => Boolean(v)),
    ]);
    campaignBoard = [...ids].map((id) => {
      const insight = ci.find((r) => r.campaign_id === id) ?? null;
      const mine = leads.filter((l) => l.campaign_id === id);
      const reachedHere = (stage: Status) => {
        const need = rankOf(stage);
        return mine.filter((l) => rankOf(l.status) >= need && rankOf(l.status) > 0).length;
      };
      const spendHere = insight ? Number(insight.spend) : 0;
      const q = reachedHere("qualified");
      const resv = mine.filter((l) => l.status === "reservation").length;
      return {
        campaign_id: id,
        campaign_name:
          insight?.campaign_name ?? mine.find((l) => l.campaign_name)?.campaign_name ?? id,
        ad_account_id: (insight as { ad_account_id?: string } | null)?.ad_account_id ?? null,
        spend: money(spendHere),
        meta_leads: insight ? Number(insight.meta_leads) : 0,
        leads: mine.length,
        untouched: mine.filter((l) => l.status === "new").length,
        no_answer: mine.filter((l) => l.status === "no_answer").length,
        disqualified: mine.filter((l) => l.status === "disqualified").length,
        qualified: q,
        qualified_pct: pct(q, mine.length),
        avg_quality: (() => {
          const qs = mine
            .map((l) => (l as { quality_score?: number | null }).quality_score)
            .filter((v): v is number => v != null);
          return qs.length > 0 ? Math.round(qs.reduce((a, b) => a + b, 0) / qs.length) : null;
        })(),
        reservations: resv,
        cost_per_lead: mine.length && spendHere ? money(spendHere / mine.length) : null,
        cost_per_qualified: q && spendHere ? money(spendHere / q) : null,
        currency: insight?.currency ?? currency,
        date_start: insight?.date_start ?? null,
        date_stop: insight?.date_stop ?? null,
      };
    }).sort((a, b) => Number(b.spend) - Number(a.spend) || Number(b.leads) - Number(a.leads));
  }

  return NextResponse.json({
    ok: true,
    currency,
    currencies,
    mixedCurrency,
    scope: scoped,
    campaigns,
    // Verbatim from Meta — nothing here is derived from our own lead table.
    meta,
    // Our pipeline. Cost-per-stage divides Meta's spend by OUR counts, which is
    // the more useful number day to day: our lead count is exact and immediate,
    // Meta's lags. The two are shown side by side rather than blended.
    kpis: {
      leads: total,
      untouched,
      spend,
      reach,
      impressions,
      clicks,
      ctr: meta.ctr,
      cost_per_lead: total ? money(spend / total) : null,
      qualified,
      qualified_pct: pct(qualified, total),
      cost_per_qualified: qualified ? money(spend / qualified) : null,
      site_visits: siteVisits,
      cost_per_site_visit: siteVisits ? money(spend / siteVisits) : null,
      reservations,
      cost_per_reservation: reservations ? money(spend / reservations) : null,
      reservation_value: reservationValue,
      roas: spend > 0 && reservationValue > 0 ? Math.round((reservationValue / spend) * 100) / 100 : null,
      median_response_hours: median,
      contacted_within_hour_pct: withinHour,
    },
    funnel,
    byStatus,
    campaignBoard,
    ads,
    daily,
    segments,
    platforms,
    dictionary: dict,
  });
}
