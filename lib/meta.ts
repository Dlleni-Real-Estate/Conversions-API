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

export const metaConfig = () => ({
  token: requireEnv("META_ACCESS_TOKEN"),
  pageId: requireEnv("META_PAGE_ID"),
  datasetId: requireEnv("META_DATASET_ID"),
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
