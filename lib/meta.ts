/**
 * Meta Graph API client.
 *
 * The one trap that breaks most lead-ads integrations: page-scoped edges
 * (/{page-id}/leadgen_forms, /{form-id}/leads) REJECT a System-User token with
 *   "(#190) This method must be called with a Page Access Token".
 * So we exchange for a Page token once and cache it. For a System User with
 * Full control of the Page, that Page token does not expire.
 */

const GRAPH = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

/**
 * ── Hard scope lock ────────────────────────────────────────────────────────
 * Every CAPI event Dlleni sends goes to exactly ONE dataset:
 *   "Dlleni CRM Events" (1718089652564651)
 * which is connected to exactly ONE ad account:
 *   "dlleni ads one" (736420925136885)
 *
 * A dataset that is not connected to the ad account still returns HTTP 200 and
 * `events_received: 1` — the signal simply never reaches the account. That silent
 * failure is the whole reason this check exists: a wrong META_DATASET_ID must
 * crash loudly at startup, not look like success for weeks.
 */
export const ALLOWED_DATASET_ID = "1718089652564651";    // Dlleni CRM Events
export const ALLOWED_AD_ACCOUNT_ID = "736420925136885";  // dlleni ads one

/** Datasets that exist in the business but must never receive our events. */
const RETIRED_DATASETS: Record<string, string> = {
  "2918655091623838": "dlleni p — web pixel, retired from this pipeline",
  "23877785175175938": "DAMAC Riverside Pixel — dead, never received an event",
  "624600273403733": "Damac Evenv — dead, never received an event",
  "1359964318405226": "Dlleni - دلني Event Data — not used",
};

function assertAllowedDataset(datasetId: string): string {
  if (datasetId === ALLOWED_DATASET_ID) return datasetId;
  const reason = RETIRED_DATASETS[datasetId];
  throw new Error(
    `Refusing to send Conversions API events to dataset ${datasetId}` +
      (reason ? ` (${reason})` : "") +
      `. This deployment only writes to ${ALLOWED_DATASET_ID} (Dlleni CRM Events), ` +
      `the dataset connected to ad account ${ALLOWED_AD_ACCOUNT_ID} (dlleni ads one). ` +
      `Fix META_DATASET_ID in the environment.`
  );
}

function assertAllowedAdAccount(): void {
  const id = (process.env.META_AD_ACCOUNT_ID || "").replace(/^act_/, "");
  if (id && id !== ALLOWED_AD_ACCOUNT_ID) {
    throw new Error(
      `Refusing to run against ad account ${id}. This deployment is locked to ` +
        `${ALLOWED_AD_ACCOUNT_ID} (dlleni ads one). Fix META_AD_ACCOUNT_ID.`
    );
  }
}

export const metaConfig = () => {
  assertAllowedAdAccount();
  return {
    token: requireEnv("META_ACCESS_TOKEN"),
    pageId: requireEnv("META_PAGE_ID"),
    datasetId: assertAllowedDataset(requireEnv("META_DATASET_ID")),
    adAccountId: ALLOWED_AD_ACCOUNT_ID,
    testEventCode: process.env.META_TEST_EVENT_CODE || undefined,
  };
};

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } };

async function graph<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}${path}?${qs}`, {
    method: "GET",
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const body = (await res.json()) as T & GraphError;
  if (!res.ok || body.error) {
    const e = body.error;
    throw new Error(
      `Graph GET ${path} failed: ${e?.message ?? res.statusText}` +
        (e?.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "")
    );
  }
  return body;
}

// ── Page access token (cached for the life of the lambda instance) ──────────
let pageTokenCache: { pageId: string; token: string } | null = null;

export async function getPageToken(): Promise<string> {
  const { token, pageId } = metaConfig();
  if (pageTokenCache?.pageId === pageId) return pageTokenCache.token;

  const data = await graph<{ access_token?: string }>(`/${pageId}`, { fields: "access_token" }, token);
  if (!data.access_token) {
    throw new Error(
      `No Page access token returned for Page ${pageId}. Assign the Page to this token's ` +
        `System User with Full control, and make sure the token has pages_show_list + pages_manage_ads.`
    );
  }
  pageTokenCache = { pageId, token: data.access_token };
  return data.access_token;
}

// ── Lead forms ──────────────────────────────────────────────────────────────
export type LeadForm = { id: string; name: string; status?: string; leads_count?: number };

export async function listLeadForms(): Promise<LeadForm[]> {
  const pageToken = await getPageToken();
  const { pageId } = metaConfig();
  const out: LeadForm[] = [];
  let after: string | undefined;

  do {
    const page: { data: LeadForm[]; paging?: { cursors?: { after?: string }; next?: string } } =
      await graph(
        `/${pageId}/leadgen_forms`,
        { fields: "id,name,status,leads_count", limit: "100", ...(after ? { after } : {}) },
        pageToken
      );
    out.push(...(page.data || []));
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  return out;
}

// ── Leads ───────────────────────────────────────────────────────────────────
export type RawLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
  field_data?: { name: string; values: string[] }[];
};

const LEAD_FIELDS =
  "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data";

/**
 * Pull leads for one form. `since` is a unix timestamp (seconds) — we only ask
 * Meta for leads newer than what we already stored, so the cron stays cheap.
 */
export async function fetchFormLeads(formId: string, since?: number): Promise<RawLead[]> {
  const pageToken = await getPageToken();
  const out: RawLead[] = [];
  let after: string | undefined;

  do {
    const page: { data: RawLead[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(
      `/${formId}/leads`,
      {
        fields: LEAD_FIELDS,
        limit: "100",
        ...(since ? { filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]) } : {}),
        ...(after ? { after } : {}),
      },
      pageToken
    );
    out.push(...(page.data || []));
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  return out;
}

// ── Field extraction ────────────────────────────────────────────────────────
const NAME_KEYS = ["full_name", "first_name", "الاسم", "name"];
// Prefer the number the buyer typed themselves (WhatsApp) over the one Meta
// auto-fills — the typed one is the number they actually answer on.
const PHONE_KEYS = ["whatsapp", "واتساب", "phone_number", "phone", "رقم"];
const EMAIL_KEYS = ["email", "بريد"];

/**
 * Picks a field by keyword PRIORITY, not by the order the form happens to list
 * its questions in. The outer loop walks `keys`, so the first keyword that
 * matches anything wins — which is what makes the ordering of PHONE_KEYS below
 * actually mean something.
 */
function pick(fields: Record<string, string>, keys: string[]): string | undefined {
  for (const want of keys) {
    for (const [name, value] of Object.entries(fields)) {
      if (name.toLowerCase().includes(want) && value?.trim()) return value;
    }
  }
  return undefined;
}

export function flattenFields(lead: RawLead): {
  fields: Record<string, string>;
  full_name?: string;
  phone?: string;
  email?: string;
} {
  const fields: Record<string, string> = {};
  for (const f of lead.field_data || []) fields[f.name] = (f.values || []).join(", ");
  return {
    fields,
    full_name: pick(fields, NAME_KEYS),
    phone: pick(fields, PHONE_KEYS),
    email: pick(fields, EMAIL_KEYS),
  };
}

/**
 * Egyptian mobile numbers arrive as 01xxxxxxxxx, +2 01x..., 002 01x... etc.
 * Meta wants E.164 digits with country code and no punctuation.
 */
export function normalizeEgyptPhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  let d = raw.replace(/\D/g, "");
  if (!d) return undefined;
  d = d.replace(/^00/, "");
  if (d.startsWith("20")) return d;
  if (d.startsWith("0")) return `20${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("1")) return `20${d}`;
  return d;
}

// ── Campaigns / ads (System-User token, NOT the Page token) ─────────────────
//
// Leads are pulled by walking campaign → ads → /{ad-id}/leads instead of
// sweeping every form on the Page. Two reasons:
//   1. It is the only way to scope the pull to specific campaigns — a lead form
//      is not owned by a campaign, the same form can run under several.
//   2. It is far cheaper: one call per tracked campaign plus one per ad, versus
//      one call per form on the Page (78 and counting).
//
// The walk also hands us campaign/adset/ad names for free, so we do not depend
// on Meta echoing them back on the lead object.

export type Campaign = {
  id: string;
  name: string;
  created_time: string;
  status?: string;
  effective_status?: string;
  objective?: string;
};

export async function listCampaigns(): Promise<Campaign[]> {
  const { token, adAccountId } = metaConfig();
  const out: Campaign[] = [];
  let after: string | undefined;

  do {
    const page: { data: Campaign[]; paging?: { cursors?: { after?: string }; next?: string } } =
      await graph(
        `/act_${adAccountId}/campaigns`,
        {
          fields: "id,name,created_time,status,effective_status,objective",
          limit: "200",
          ...(after ? { after } : {}),
        },
        token
      );
    out.push(...(page.data || []));
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  out.sort((a, b) => (a.created_time < b.created_time ? 1 : -1));
  return out;
}

export type CampaignAd = { id: string; name: string; adset_id?: string; adset_name?: string };

/**
 * Ads under a campaign. Meta hides DELETED/ARCHIVED ads on this edge, so leads
 * that only ever belonged to a deleted ad will not be picked up — acceptable,
 * since a deleted ad is not a campaign anyone is still optimising.
 */
export async function listCampaignAds(campaignId: string): Promise<CampaignAd[]> {
  const { token } = metaConfig();
  const out: CampaignAd[] = [];
  let after: string | undefined;

  type Row = { id: string; name: string; adset_id?: string; adset?: { id?: string; name?: string } };

  do {
    const page: { data: Row[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(
      `/${campaignId}/ads`,
      { fields: "id,name,adset_id,adset{id,name}", limit: "200", ...(after ? { after } : {}) },
      token
    );
    for (const r of page.data || []) {
      out.push({ id: r.id, name: r.name, adset_id: r.adset_id ?? r.adset?.id, adset_name: r.adset?.name });
    }
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  return out;
}

/** Leads for one ad. Page-scoped edge, so it needs the Page token like forms do. */
export async function fetchAdLeads(adId: string, since?: number): Promise<RawLead[]> {
  const pageToken = await getPageToken();
  const out: RawLead[] = [];
  let after: string | undefined;

  do {
    const page: { data: RawLead[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(
      `/${adId}/leads`,
      {
        fields: LEAD_FIELDS,
        limit: "100",
        ...(since
          ? { filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]) }
          : {}),
        ...(after ? { after } : {}),
      },
      pageToken
    );
    out.push(...(page.data || []));
    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  return out;
}

// ── Delivery & spend ────────────────────────────────────────────────────────
//
// Lifetime insights at ad level for one campaign. This is what turns the
// dashboard from "which creative brings nice-looking leads" into "which
// creative brings a reservation for the least money".

export type AdInsight = {
  ad_id: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
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
  currency?: string;
  date_start?: string;
  date_stop?: string;
};

type InsightRow = {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  inline_link_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  account_currency?: string;
  date_start?: string;
  date_stop?: string;
  actions?: { action_type: string; value: string }[];
  cost_per_action_type?: { action_type: string; value: string }[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Meta reports a lead-form submission under more than one action_type
 * depending on placement and API version, and the same lead can appear under
 * several of them. Take the largest rather than the sum, or the count doubles.
 */
const LEAD_ACTION_TYPES = ["onsite_conversion.lead_grouped", "leadgen.other", "lead", "offsite_conversion.fb_pixel_lead"];

function leadCount(actions?: { action_type: string; value: string }[]): number {
  if (!actions) return 0;
  let best = 0;
  for (const a of actions) {
    if (LEAD_ACTION_TYPES.includes(a.action_type)) best = Math.max(best, num(a.value));
  }
  return best;
}

function costPerLead(rows?: { action_type: string; value: string }[]): number | null {
  if (!rows) return null;
  for (const t of LEAD_ACTION_TYPES) {
    const hit = rows.find((r) => r.action_type === t);
    if (hit) return num(hit.value);
  }
  return null;
}

export type CampaignInsight = Omit<AdInsight, "ad_id" | "ad_name" | "adset_id" | "adset_name"> & {
  campaign_id: string;
  campaign_name?: string;
};

/**
 * Meta's own campaign-level numbers, taken verbatim.
 *
 * Do NOT compute these by adding up the ad rows. Reach is deduplicated people:
 * one person who saw two ads is one reach at campaign level and two if you
 * add. Spend and impressions can also differ slightly, because attribution is
 * applied per level. When the dashboard and Ads Manager disagree, the reason is
 * almost always that someone added something Meta had already deduplicated.
 */
export async function fetchCampaignInsights(campaignId: string): Promise<CampaignInsight | null> {
  const { token } = metaConfig();
  const page: { data: InsightRow[] } = await graph(
    `/${campaignId}/insights`,
    {
      level: "campaign",
      date_preset: "maximum",
      limit: "1",
      fields:
        "campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks," +
        "ctr,cpc,cpm,actions,cost_per_action_type,account_currency",
    },
    token
  );

  const r = page.data?.[0];
  if (!r) return null;

  return {
    campaign_id: r.campaign_id ?? campaignId,
    campaign_name: r.campaign_name,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    frequency: num(r.frequency),
    clicks: num(r.clicks),
    link_clicks: num(r.inline_link_clicks),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    cpm: num(r.cpm),
    meta_leads: leadCount(r.actions),
    cost_per_lead: costPerLead(r.cost_per_action_type),
    currency: r.account_currency,
    date_start: r.date_start,
    date_stop: r.date_stop,
  };
}

export async function fetchCampaignAdInsights(campaignId: string): Promise<AdInsight[]> {
  const { token } = metaConfig();
  const out: AdInsight[] = [];
  let after: string | undefined;

  do {
    const page: { data: InsightRow[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(
      `/${campaignId}/insights`,
      {
        level: "ad",
        date_preset: "maximum",
        limit: "200",
        fields:
          "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach," +
          "frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,cost_per_action_type,account_currency",
        ...(after ? { after } : {}),
      },
      token
    );

    for (const r of page.data || []) {
      if (!r.ad_id) continue;
      out.push({
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        adset_id: r.adset_id,
        adset_name: r.adset_name,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        spend: num(r.spend),
        impressions: num(r.impressions),
        reach: num(r.reach),
        frequency: num(r.frequency),
        clicks: num(r.clicks),
        link_clicks: num(r.inline_link_clicks),
        ctr: num(r.ctr),
        cpc: num(r.cpc),
        cpm: num(r.cpm),
        meta_leads: leadCount(r.actions),
        cost_per_lead: costPerLead(r.cost_per_action_type),
        currency: r.account_currency,
        date_start: r.date_start,
        date_stop: r.date_stop,
      });
    }

    after = page.paging?.next ? page.paging?.cursors?.after : undefined;
  } while (after);

  return out;
}

// ── Form schema (the actual wording the customer read) ──────────────────────
//
// A lead comes back as machine keys: { payment_method: "still_exploring" }.
// The Arabic the customer actually saw — "تحب تدفع إزاي؟" and
// "لسه بستكشف وبسأل" — lives only on the form definition. Fetch it once per
// form and keep it for display; never translate, never paraphrase.

export type FormQuestion = {
  key: string;
  label: string;
  type?: string;
  options?: { key: string; value: string }[];
};

export type FormSchema = {
  form_id: string;
  name: string;
  locale: string | null;
  questions: FormQuestion[];
};

export async function fetchFormSchema(formId: string): Promise<FormSchema> {
  const pageToken = await getPageToken();
  const data = await graph<{ id: string; name?: string; locale?: string; questions?: FormQuestion[] }>(
    `/${formId}`,
    { fields: "id,name,locale,questions" },
    pageToken
  );
  return {
    form_id: data.id,
    name: data.name ?? formId,
    locale: data.locale ?? null,
    questions: data.questions ?? [],
  };
}
