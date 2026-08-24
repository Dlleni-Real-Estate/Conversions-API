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
 * ── Scope ──────────────────────────────────────────────────────────────────
 * This used to be a hard lock: one dataset, one ad account, both constants,
 * and any other value threw at startup. The lock existed for one specific
 * reason, and that reason has not gone away — a dataset that is NOT connected
 * to the ad account still returns HTTP 200 and `events_received: 1`. The
 * signal simply never reaches the account. Nothing anywhere reports it.
 *
 * So supporting several accounts is not a matter of deleting the check. It is
 * a matter of moving it from compile time to connect time: a pairing is only
 * ever stored after asking Meta which datasets are actually connected to that
 * account and confirming the chosen one is among them. The guarantee is the
 * same; what changed is that Meta answers the question instead of a constant.
 *
 * The seed pairing is kept here as the fallback used when the ad_accounts
 * table has not been read — the account that has been sending accepted events
 * for days, which is the strongest verification available.
 */
export const SEED_DATASET_ID = "1718089652564651";    // Dlleni CRM Events
export const SEED_AD_ACCOUNT_ID = "736420925136885";  // dlleni ads one

/**
 * One ad account and the dataset its events belong in. Every Meta call takes
 * one of these rather than reading the environment, so two accounts can never
 * quietly share one dataset by virtue of running in the same process.
 */
export type AccountScope = {
  adAccountId: string;
  datasetId: string;
  pageId: string;
  name?: string;
  /**
   * Token for every Meta call about this account. Unset means the deployment
   * token. An account in ANOTHER Business needs its own: the deployment token
   * cannot see that Business's assets at all, and worse, a CAPI send with the
   * wrong token to the wrong dataset is accepted with a 200 and attributed to
   * nothing. The token that verified the pairing is the token that sends.
   */
  token?: string;
};

/** The scope built from environment variables — the one the cron falls back to. */
export function envScope(): AccountScope {
  return {
    adAccountId: (process.env.META_AD_ACCOUNT_ID || SEED_AD_ACCOUNT_ID).replace(/^act_/, ""),
    datasetId: process.env.META_DATASET_ID || SEED_DATASET_ID,
    pageId: requireEnv("META_PAGE_ID"),
  };
}

/**
 * The datasets Meta says are connected to this ad account, straight from
 * /act_<id>/adspixels. An empty array is the answer that matters most: it
 * means no dataset is assigned, so any events sent for this account would be
 * accepted and then attributed to nothing.
 */
export async function datasetsForAccount(adAccountId: string, tokenOverride?: string): Promise<{ id: string; name?: string }[]> {
  const token = tokenOverride || metaConfig().token;
  const id = adAccountId.replace(/^act_/, "");
  const json = await graph<{ data?: { id: string; name?: string }[] }>(
    `/act_${id}/adspixels`,
    { fields: "id,name", limit: "50" },
    token
  );
  return json.data ?? [];
}

/** Every ad account this token can see, for the connect screen's picker. */
export async function listAdAccounts(tokenOverride?: string): Promise<
  { id: string; name?: string; currency?: string; status?: number; business_id?: string; business_name?: string }[]
> {
  const token = tokenOverride || metaConfig().token;
  // One Facebook account routinely manages several Businesses, and this edge
  // returns the ad accounts of ALL of them in one flat list. The owning
  // Business rides along on each row so the picker can group by it - a flat
  // list of same-looking account names across three Businesses is how the
  // wrong one gets connected.
  const json = await graph<{
    data?: {
      account_id: string; name?: string; currency?: string; account_status?: number;
      business?: { id?: string; name?: string };
    }[];
  }>(
    "/me/adaccounts",
    { fields: "account_id,name,currency,account_status,business{id,name}", limit: "100" },
    token
  );
  return (json.data ?? []).map((a) => ({
    id: a.account_id, name: a.name, currency: a.currency, status: a.account_status,
    business_id: a.business?.id, business_name: a.business?.name,
  }));
}

/**
 * The Businesses this token was actually granted, from /me/businesses.
 *
 * This is the reliable grouping signal. The business field on /me/adaccounts
 * often comes back EMPTY under Facebook's granular consent, which flattened
 * the whole picker into one "personal" pile - a real bug seen live. The
 * granted Businesses themselves always list.
 */
export async function grantedBusinesses(tokenOverride?: string): Promise<{ id: string; name?: string }[]> {
  const token = tokenOverride || metaConfig().token;
  try {
    const json = await graph<{ data?: { id: string; name?: string }[] }>(
      "/me/businesses",
      { fields: "id,name", limit: "100" },
      token
    );
    return json.data ?? [];
  } catch {
    return [];
  }
}

/** Ad account ids a Business owns or manages for clients. */
export async function businessAccountIds(businessId: string, tokenOverride?: string): Promise<string[]> {
  const token = tokenOverride || metaConfig().token;
  const out = new Set<string>();
  for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
    try {
      const json = await graph<{ data?: { account_id?: string }[] }>(
        `/${businessId}/${edge}`,
        { fields: "account_id", limit: "200" },
        token
      );
      for (const a of json.data ?? []) if (a.account_id) out.add(a.account_id);
    } catch {
      // An edge this token cannot read contributes nothing - not an error.
    }
  }
  return [...out];
}

/**
 * Event Match Quality per event, from Meta's Dataset Quality API - the same
 * numbers Events Manager shows. composite_score is out of 10. Events with no
 * recent traffic are simply absent. Weak EMQ is the failure mode with green
 * lights everywhere: events accepted, dashboard clean, and Meta quietly unable
 * to match them back to people, so the optimisation feedback goes nowhere.
 */
export type EmqEvent = {
  event_name: string;
  score: number | null;
  match_keys: { identifier: string; coverage: number }[];
};

export async function datasetQuality(datasetId: string, tokenOverride?: string): Promise<EmqEvent[]> {
  const token = tokenOverride || metaConfig().token;
  try {
    const json = await graph<{
      web?: {
        event_name?: string;
        event_match_quality?: {
          composite_score?: number;
          match_key_feedback?: { identifier?: string; coverage?: { percentage?: number } }[];
        };
      }[];
    }>("/dataset_quality", { dataset_id: datasetId }, token);
    return (json.web ?? []).map((e) => ({
      event_name: e.event_name ?? "?",
      score: typeof e.event_match_quality?.composite_score === "number" ? e.event_match_quality.composite_score : null,
      match_keys: (e.event_match_quality?.match_key_feedback ?? []).map((k) => ({
        identifier: k.identifier ?? "?",
        coverage: k.coverage?.percentage ?? 0,
      })),
    }));
  } catch {
    return [];
  }
}

/**
 * Pages that belong to an ad account's Business - owned or managed for
 * clients. The picker offers THESE when the account itself names no Page,
 * because a fourteen-Page personal list with an alphabetical default was how
 * "AR Elite Properties" nearly became a lead source.
 */
export async function businessPages(businessId: string, tokenOverride?: string): Promise<{ id: string; name?: string }[]> {
  const token = tokenOverride || metaConfig().token;
  const out = new Map<string, { id: string; name?: string }>();
  for (const edge of ["owned_pages", "client_pages"]) {
    try {
      const json = await graph<{ data?: { id: string; name?: string }[] }>(
        `/${businessId}/${edge}`,
        { fields: "id,name", limit: "100" },
        token
      );
      for (const p of json.data ?? []) out.set(p.id, p);
    } catch {
      // An edge this token cannot read contributes nothing.
    }
  }
  return [...out.values()];
}

/**
 * Create a dataset ON the ad account, via POST /act_<id>/adspixels.
 *
 * The decisive property: a dataset created this way is born CONNECTED to that
 * ad account - the pairing the whole system verifies before sending exists by
 * construction, and the manual Business Settings walk disappears. Quality is
 * not a dataset setting: it comes from what the events carry (lead_id, hashed
 * phone and email), which lib/capi.ts already sends on every event.
 */
export async function createDataset(
  adAccountId: string,
  name: string,
  tokenOverride?: string
): Promise<{ id: string } | { error: string }> {
  const token = tokenOverride || metaConfig().token;
  const id = adAccountId.replace(/^act_/, "");
  try {
    const res = await fetch(`${GRAPH}/act_${id}/adspixels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, access_token: token }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || json.error || !json.id) {
      return { error: json.error?.message || `HTTP ${res.status}` };
    }
    return { id: json.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Who actually signed in - shown so a wrong account is caught by eye. */
export async function tokenOwnerName(tokenOverride?: string): Promise<string | null> {
  const token = tokenOverride || metaConfig().token;
  try {
    const json = await graph<{ name?: string }>("/me", { fields: "name" }, token);
    return json.name ?? null;
  } catch {
    return null;
  }
}

/** Which Business owns this ad account, from the account itself. */
export async function accountBusiness(
  adAccountId: string,
  tokenOverride?: string
): Promise<{ id?: string; name?: string }> {
  const token = tokenOverride || metaConfig().token;
  const id = adAccountId.replace(/^act_/, "");
  try {
    const json = await graph<{ business?: { id?: string; name?: string } }>(
      `/act_${id}`,
      { fields: "business{id,name}" },
      token
    );
    return json.business ?? {};
  } catch {
    // A personal (non-Business) ad account has none; not an error.
    return {};
  }
}

/**
 * The Pages this ad account is allowed to advertise for.
 *
 * This matters more than it looks. Lead retrieval is a PAGE-scoped edge: the
 * leads of an ad are read with the token of the Page that owns the form, not
 * the ad account's. Pair a second ad account with the first account's Page and
 * every campaign lists fine, every insight reports fine, and zero leads ever
 * arrive - with no error to explain it. So the Page is asked for at connect
 * time and stored per account instead of inherited from the environment.
 */
export type AccountPages = {
  pages: { id: string; name?: string }[];
  /**
   * "account" - Meta ties these Pages to this ad account. That is an answer.
   * "user"    - Meta ties NONE to it, so these are the Pages the token can
   *             see. That is a choice for a human, not an answer, and it is
   *             labelled as one rather than being quietly picked from.
   * "none"    - nothing to offer.
   */
  source: "account" | "user" | "none";
  /** Set when Meta refused the question, which is not the same as answering none. */
  error?: string;
};

export async function pagesForAccount(adAccountId: string, tokenOverride?: string): Promise<AccountPages> {
  const token = tokenOverride || metaConfig().token;
  const id = adAccountId.replace(/^act_/, "");
  let error: string | undefined;

  try {
    const json = await graph<{ data?: { id: string; name?: string }[] }>(
      `/act_${id}/promote_pages`,
      { fields: "id,name", limit: "50" },
      token
    );
    const pages = json.data ?? [];
    if (pages.length > 0) return { pages, source: "account" };
  } catch (err) {
    // Recorded, not swallowed. An empty list and a refused question look the
    // same to every caller unless one of them says which it was.
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    const json = await graph<{ data?: { id: string; name?: string }[] }>(
      "/me/accounts",
      { fields: "id,name", limit: "100" },
      token
    );
    const pages = json.data ?? [];
    return { pages, source: pages.length > 0 ? "user" : "none", error };
  } catch (err) {
    return { pages: [], source: "none", error: error ?? (err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Is this pairing real? The one question the old constant answered by fiat.
 * Returns the dataset's name when it checks out, so the caller can store it.
 */
export async function verifyPairing(
  adAccountId: string,
  datasetId: string,
  tokenOverride?: string
): Promise<{ ok: true; datasetName?: string } | { ok: false; error: string; available: { id: string; name?: string }[] }> {
  const available = await datasetsForAccount(adAccountId, tokenOverride);
  const match = available.find((d) => d.id === datasetId);
  if (match) return { ok: true, datasetName: match.name };
  return {
    ok: false,
    available,
    error:
      available.length === 0
        ? `Ad account ${adAccountId} has no dataset connected to it. Assign one in Meta Business Settings ` +
          `(Data sources > Datasets > Connected assets > Add ad account) before connecting it here — until then ` +
          `Meta would accept every event for this account and attribute it to nothing.`
        : `Dataset ${datasetId} is not connected to ad account ${adAccountId}. Connected: ` +
          available.map((d) => `${d.id}${d.name ? ` (${d.name})` : ""}`).join(", "),
  };
}

export const metaConfig = () => ({
  token: requireEnv("META_ACCESS_TOKEN"),
  pageId: process.env.META_PAGE_ID || "",
  datasetId: process.env.META_DATASET_ID || SEED_DATASET_ID,
  adAccountId: (process.env.META_AD_ACCOUNT_ID || SEED_AD_ACCOUNT_ID).replace(/^act_/, ""),
  testEventCode: process.env.META_TEST_EVENT_CODE || undefined,
});

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
// Keyed by pageId: two accounts can own different Pages, and a token cached
// for one Page is useless (and confusing) for the other.
const pageTokenCache = new Map<string, string>();

export async function getPageToken(scope?: AccountScope): Promise<string> {
  const token = scope?.token || metaConfig().token;
  const pageId = scope?.pageId || metaConfig().pageId;
  // Keyed by page AND token: the same Page id asked about with two different
  // tokens is two different questions, and the wrong cached answer would be
  // a page token the other Business never granted.
  const cacheKey = `${pageId}|${token.slice(-8)}`;
  const cached = pageTokenCache.get(cacheKey);
  if (cached) return cached;

  const data = await graph<{ access_token?: string }>(`/${pageId}`, { fields: "access_token" }, token);
  if (!data.access_token) {
    throw new Error(
      `No Page access token returned for Page ${pageId}. Assign the Page to this token's ` +
        `System User with Full control, and make sure the token has pages_show_list + pages_manage_ads.`
    );
  }
  pageTokenCache.set(cacheKey, data.access_token);
  return data.access_token;
}

// ── Lead forms ──────────────────────────────────────────────────────────────
export type LeadForm = { id: string; name: string; status?: string; leads_count?: number };

export async function listLeadForms(scope?: AccountScope): Promise<LeadForm[]> {
  const pageToken = await getPageToken(scope);
  const pageId = scope?.pageId || metaConfig().pageId;
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
export async function fetchFormLeads(formId: string, since?: number, scope?: AccountScope): Promise<RawLead[]> {
  const pageToken = await getPageToken(scope);
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
  /**
   * Which account this campaign was listed from. Stamped here rather than
   * inferred later: once campaigns from two accounts are in one array, nothing
   * else in the row says where it came from, and routing a lead's events to the
   * wrong account's dataset is the one mistake Meta accepts without complaint.
   */
  ad_account_id?: string;
  account_name?: string;
};

export async function listCampaigns(scope?: AccountScope): Promise<Campaign[]> {
  const token = scope?.token || metaConfig().token;
  const adAccountId = scope?.adAccountId || metaConfig().adAccountId;
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
  return out.map((c) => ({ ...c, ad_account_id: adAccountId, account_name: scope?.name }));
}

export type CampaignAd = { id: string; name: string; adset_id?: string; adset_name?: string };

/**
 * Ads under a campaign. Meta hides DELETED/ARCHIVED ads on this edge, so leads
 * that only ever belonged to a deleted ad will not be picked up — acceptable,
 * since a deleted ad is not a campaign anyone is still optimising.
 */
export async function listCampaignAds(campaignId: string, scope?: AccountScope): Promise<CampaignAd[]> {
  const token = scope?.token || metaConfig().token;
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
export async function fetchAdLeads(adId: string, since?: number, scope?: AccountScope): Promise<RawLead[]> {
  const pageToken = await getPageToken(scope);
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

// ── Reporting window ────────────────────────────────────────────────────────
//
// THE TRAP: `date_preset=maximum` and `date_preset=last_30d` both stop at
// YESTERDAY in this API. Ads Manager's "Maximum" includes today. On a campaign
// that just scaled, that is not a rounding difference — it read 442 EGP of
// spend when the real number was 1,551.
//
// So we always ask for an explicit time_range ending on TODAY in the ad
// account's own timezone (Meta reports on the account's clock, not UTC), and
// we ask for the whole span in one call: reach deduplicates people across days
// as well as across ads, so two calls added together would overstate it again.

// Keyed by account: two ad accounts can sit in different timezones, and a
// date window computed in the wrong one silently shifts every insight by a day.
const timezoneCache = new Map<string, string>();

async function accountTimezone(scope?: AccountScope): Promise<string> {
  const token = scope?.token || metaConfig().token;
  const adAccountId = scope?.adAccountId || metaConfig().adAccountId;
  const hit = timezoneCache.get(adAccountId);
  if (hit) return hit;
  const data = await graph<{ timezone_name?: string }>(
    `/act_${adAccountId}`,
    { fields: "timezone_name" },
    token
  );
  const tz = data.timezone_name || "UTC";
  timezoneCache.set(adAccountId, tz);
  return tz;
}

/** YYYY-MM-DD in a given timezone. en-CA is the locale that formats that way. */
function ymd(tz: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Campaign creation (or three years back) through today, account time. */
async function insightsWindow(sinceIso?: string, scope?: AccountScope): Promise<{ since: string; until: string }> {
  // The window is computed in the OWNING account's timezone. Two accounts in
  // different zones would otherwise have one of them shifted by a day, which
  // reads as a spend discrepancy nobody can explain.
  const tz = await accountTimezone(scope);
  const now = new Date();
  const fallback = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 365 * 3); // inside Meta's 37-month limit
  const start = sinceIso && !Number.isNaN(Date.parse(sinceIso)) ? new Date(sinceIso) : fallback;
  return { since: ymd(tz, start), until: ymd(tz, now) };
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
export async function fetchCampaignInsights(
  campaignId: string,
  createdTime?: string,
  scope?: AccountScope
): Promise<CampaignInsight | null> {
  const token = scope?.token || metaConfig().token;
  const page: { data: InsightRow[] } = await graph(
    `/${campaignId}/insights`,
    {
      level: "campaign",
      time_range: JSON.stringify(await insightsWindow(createdTime, scope)),
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

export async function fetchCampaignAdInsights(
  campaignId: string,
  createdTime?: string,
  scope?: AccountScope
): Promise<AdInsight[]> {
  const token = scope?.token || metaConfig().token;
  const out: AdInsight[] = [];
  let after: string | undefined;
  const window = await insightsWindow(createdTime, scope);

  do {
    const page: { data: InsightRow[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(
      `/${campaignId}/insights`,
      {
        level: "ad",
        time_range: JSON.stringify(window),
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

export async function fetchFormSchema(formId: string, scope?: AccountScope): Promise<FormSchema> {
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
