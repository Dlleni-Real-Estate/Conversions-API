/**
 * Reading lead stages back out of 8X CRM.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The sales team works in 8X CRM — 13,682 leads there against a handful here.
 * So the CRM owns the truth about what happened to a lead, and this app's job
 * is to mirror that truth, not to ask anyone to type it twice.
 *
 * WHAT THE API ACTUALLY IS
 * ────────────────────────
 * 8X documents exactly one read endpoint (Settings → Integrations → Website /
 * Custom → Search Leads Docs):
 *
 *   GET /api/v1/leads/leads/normal_lead_search   body: {"needle":"", "limit":""}
 *
 * `needle` is a free-text search — the documented example is a phone number.
 * There is NO bulk export, no pagination, no updated-since filter. So this is
 * a lookup, one lead at a time, and the shape of the sync follows from that:
 * we already hold every lead Meta gave us, complete with the phone the customer
 * typed into the instant form, so we walk OUR list and ask the CRM about each.
 * That also means we never pull leads that aren't ours to see.
 *
 * TWO TRAPS, BOTH DELIBERATE HERE
 * ───────────────────────────────
 *  1. The docs say GET *with a JSON body*. `fetch` refuses that outright
 *     ("Request with GET/HEAD method cannot have body"), so a normal fetch
 *     cannot make the documented call at all. We drop to node:https, which
 *     will. Laravel reads the body regardless of method, which is presumably
 *     why the docs are written that way.
 *  2. The API lives on 8xcrm.COM. The dashboard you log into is 8xcrm.NET.
 *     Pointing at .net returns HTML, not JSON, and looks like an auth failure.
 */

import https from "node:https";
import type { Status } from "./stages";

const BASE = (process.env.CRM_BASE_URL || "https://dlleni.8xcrm.com").replace(/\/+$/, "");
const KEY = process.env.CRM_API_KEY || "";
const SEARCH_PATH = "/api/v1/leads/leads/normal_lead_search";

/** False until the API key is set on Vercel — every caller checks this first. */
export const CRM_CONFIGURED = KEY.length > 0;

/** Fingerprint only. The key itself is never logged, returned or stored. */
export function crmKeyFingerprint(): string {
  if (!KEY) return "(unset)";
  return `len=${KEY.length} …${KEY.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

export type CallShape = "get-body" | "get-query" | "post-body";

type RawResponse = { status: number; text: string; shape: CallShape };

function raw(method: string, path: string, body: string | null): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "dlleni-capi/1.0",
      Authorization: `Bearer ${KEY}`,
    };
    if (body) headers["Content-Length"] = String(Buffer.byteLength(body));

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 20_000 },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, text }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("CRM request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * One search, in one of the three plausible calling conventions.
 * `get-body` is what the docs describe; the other two exist because a proxy or
 * a framework upgrade can silently break body-on-GET, and when that happens we
 * want a one-line switch rather than an outage nobody can explain.
 */
export async function crmSearchRaw(needle: string, limit: number, shape: CallShape): Promise<RawResponse> {
  const payload = JSON.stringify({ needle, limit: String(limit) });
  const qs = `?needle=${encodeURIComponent(needle)}&limit=${encodeURIComponent(String(limit))}`;
  const r =
    shape === "get-query" ? await raw("GET", SEARCH_PATH + qs, null)
    : shape === "post-body" ? await raw("POST", SEARCH_PATH, payload)
    : await raw("GET", SEARCH_PATH, payload);
  return { ...r, shape };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape-tolerant readers
//
// We have never seen a response body from this endpoint — 8X documents the
// request and not the reply. Rather than guess one shape and have the sync fail
// silently on a null, these dig for the field wherever it turns out to live.
// ─────────────────────────────────────────────────────────────────────────────

/** Pull the array of leads out of whatever envelope the API wraps it in. */
export function extractRows(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (!parsed || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  for (const key of ["data", "leads", "results", "records", "items", "rows"]) {
    const v = o[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    // Laravel paginators nest again: { data: { data: [...] } }
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).data;
      if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    }
  }
  return [];
}

const STAGE_KEYS = [
  "status", "stage", "lead_status", "leadStatus", "status_name", "stage_name",
  "current_status", "current_stage", "lead_stage", "state",
];

/**
 * 8X returns the stage as `status_id` — a numeric foreign key, not a name. The
 * probe proved it: every other field came back and `stageLabel` was null.
 * These are the id fields worth reading off a row; none of them is personal
 * data, so they are safe to log and to return from the probe.
 */
export const ID_FIELDS = [
  "id", "status_id", "old_status_id", "leadgen_id", "form_id", "page_id",
  "ad_id", "adgroup_id", "campaign_id", "source_id", "lead_quality_id",
  "lead_classification_id", "rating_id", "generation_source", "is_cold_calls",
  "created_at", "updated_at",
];

export function pickIds(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ID_FIELDS) if (k in row) out[k] = row[k];
  return out;
}

/**
 * status_id -> stage name, for this tenant.
 *
 * Every line below was confirmed by watching the CRM: take a lead whose
 * status_id the API returned, search its name in the workspace, read the stage
 * label off the row. Not one of them is inferred from ordering, and the reason
 * for that discipline is visible in the numbers themselves.
 *
 * THE IDS ARE NOT SEQUENTIAL. They run 69-74 and then jump to 119-124, and the
 * second block is not in the order the Stage Mappings screen lists it:
 *
 *      screen order            id
 *      7  Red Expo             121   <- the one gap, see below
 *      8  follow up after…     119
 *      9  Call Back            123
 *     10  low budget           120
 *     11  Not Available        122
 *     12  Network              124
 *
 * Reading them off in order would have put "follow up after meeting" at 121 —
 * and that stage is the deepest POSITIVE one we send, the CompleteRegistration
 * end of the funnel. Meta would have been told that leads who sat through a
 * meeting were something else entirely, and no screen anywhere would have shown
 * it, because a wrong stage name still looks like a working integration.
 *
 * 121 is the single exception and it is settled by elimination rather than
 * sight: twelve stages, eleven seen, one name left over (Red Expo) and one id
 * left over. It is also the safest possible one to be unsure about — Red Expo
 * describes where a lead came from, carries no pipeline meaning, and is mapped
 * to no Meta event.
 */
export const STATUS_ID_TO_STAGE: Record<number, string> = {
  69: "fresh leads",             // samer, Donia Magdi
  70: "cold calls",              // Nagwa Elkady
  71: "No Answer",               // Manaly farag, عادل حسن, Heba Z
  72: "interested",              // Mohamed rezk  <- the optimisation target
  73: "not interested",          // Alaa Ashraf
  74: "set a meeting",           // Rabab Osama
  119: "follow up after meeting",// Hazem Elbanna <- deepest positive stage
  120: "low budget",             // Yara Lasheen
  121: "Red Expo",               // by elimination; carries no pipeline meaning
  122: "Not Available",          // Omaima Abdullah
  123: "Call Back",              // Aly Obeid
  124: "Network",                // Ahmed elsohiely
};

/** The stage label, wherever it hides — a string, or a nested {name}/{title}. */
export function pickStageLabel(row: Record<string, unknown>): string | null {
  for (const k of STAGE_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const nk of ["name", "title", "label", "value"]) {
        const nv = o[nk];
        if (typeof nv === "string" && nv.trim()) return nv.trim();
      }
    }
  }
  return null;
}

const PHONE_KEYS = ["phone", "mobile", "phone_number", "mobile_number", "msisdn", "contact_number"];

/**
 * user id -> name, read off the CRM's own Settings > Users table, which lists
 * ID and Name side by side — the same standard as the stage map: confirmed by
 * sight, never inferred.
 *
 * Why a constant and not an API call: v4 returns assignees as bare ids, the
 * documented API has no users endpoint (every plausible path 404s — the token
 * is scoped to lead search), and the SPA's own dropdown is fed from a cached
 * bootstrap. Fourteen accounts that change a few times a year do not justify
 * scraping; an id not listed here renders as "Agent #N" and is reported by the
 * sync log, so a new hire is a one-line addition, not a silent blank.
 *
 * Two suspended accounts exist beyond these (the Assignees filter shows
 * "mohamed shawki" who is not in the active list); their ids will surface as
 * Agent #N on old leads and can be added when they do.
 */
export const CRM_USER_TO_NAME: Record<number, string> = {
  2: "General Manager",        // Islam — CRM General Manager
  7: "Muhammad Salameh",       // Sherif Team
  8: "Youstina Tadros",        // Youstina Team Leader — receives new leads
  9: "Shama Abdelhamid",       // Shama Team Leader
  10: "Abdelrahman Mohamed",   // Youstina Team
  11: "Mariam Helmy",          // Sherif Team
  12: "mohamed aboarab",       // Youstina Team
  13: "Ahmed Roshdy",          // Youstina Team
  16: "Khaled Zakaria",        // Youstina Team
  17: "aya atef",              // Youstina Team
  18: "Ahmed Moustafa",        // Abdalla Team
  19: "ali sabry",             // Youstina Team
};

const unknownUserIds = new Set<number>();

/** Name for a CRM user id; unknown ids render honestly and get reported. */
export function resolveUserName(id: unknown): string | null {
  const n = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
  if (!Number.isFinite(n)) return null;
  const name = CRM_USER_TO_NAME[n];
  if (name) return name;
  unknownUserIds.add(n);
  return `Agent #${n}`;
}

/** Unknown ids met since the last call — the sync logs these, then clears. */
export function drainUnknownUserIds(): number[] {
  const out = [...unknownUserIds];
  unknownUserIds.clear();
  return out;
}

/** A person's name out of whatever object shape the CRM uses for people. */
function personName(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  for (const k of ["full_name", "name", "display_name", "username"]) {
    const n = o[k];
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  const first = o.first_name, last = o.last_name;
  if (typeof first === "string" && first.trim()) {
    return [first, typeof last === "string" ? last : ""].join(" ").trim();
  }
  return null;
}

/**
 * The agent currently holding the lead. v4 carries `assignees` (and the
 * workspace shows exactly one name per row), so the first assignee is the
 * holder. Joined with " + " on the rare multi-assignee row rather than
 * silently dropping the second name.
 */
export function pickOwner(row: Record<string, unknown>): string | null {
  const v = row.assignees ?? row.assignee ?? row.owner ?? null;
  if (Array.isArray(v)) {
    const names = v
      .map((entry) => {
        // v4's real shape: [{id: 8, created_at: "…"}] — an id, never a name.
        if (entry && typeof entry === "object" && "id" in (entry as object)) {
          return resolveUserName((entry as Record<string, unknown>).id);
        }
        return personName(entry);
      })
      .filter((n): n is string => Boolean(n));
    return names.length ? names.join(" + ") : null;
  }
  if (typeof v === "number") return resolveUserName(v);
  return personName(v);
}

/**
 * The most recent thing written on the lead — v4's `last_activity`. The full
 * note history lives behind per-lead endpoints 8X does not document, so the
 * sync mirrors the latest note each run; over successive runs that accumulates
 * into a history on our side.
 */
export function pickLastNote(row: Record<string, unknown>): { body: string; author: string | null; at: string | null } | null {
  const v = row.last_activity ?? row.lastActivity ?? null;
  if (typeof v === "string" && v.trim()) return { body: v.trim(), author: null, at: null };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // The real v4 shape puts the text in `notes` — and an activity with
  // notes:null is a logged call with nothing written, which is a real event
  // but not a note, so it produces nothing here.
  let body: string | null = null;
  for (const k of ["notes", "description", "note", "body", "comment", "text", "content"]) {
    const b = o[k];
    if (typeof b === "string" && b.trim()) { body = b.trim(); break; }
  }
  if (!body) return null;
  // `created_by` is a user id — the agent who wrote it, not the one holding
  // the lead. Those differ exactly when a team lead annotates someone else's
  // lead, which is the case worth recording faithfully.
  let author: string | null = resolveUserName(o.created_by);
  if (!author) {
    for (const k of ["created_by_name", "user", "agent", "author", "owner"]) {
      const a = personName(o[k]);
      if (a) { author = a; break; }
    }
  }
  let at: string | null = null;
  for (const k of ["created_at", "date", "at", "updated_at"]) {
    const t = o[k];
    if (typeof t === "string" && t.trim()) { at = t; break; }
  }
  return { body, author, at };
}

export function pickPhone(row: Record<string, unknown>): string | null {
  for (const k of PHONE_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  // 8X's own storeLead payload is { phones: [{ phone, country_code }] } - the
  // lead model stores numbers as a RELATION, not a column. A manually created
  // lead often carries its number ONLY there, so reading just the flat keys
  // made phone-matching silently find nothing for exactly the leads that have
  // no leadgen_id and need it most. The first live run proved it: 56 manual
  // entries in the CRM, zero matched by phone.
  for (const k of ["phones", "phone_numbers", "mobiles", "contacts"]) {
    const v = row[k];
    if (!Array.isArray(v)) continue;
    for (const entry of v) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
      if (entry && typeof entry === "object") {
        for (const nk of ["phone", "mobile", "number", "phone_number", "value"]) {
          const nv = (entry as Record<string, unknown>)[nk];
          if (typeof nv === "string" && nv.trim()) return nv.trim();
          if (typeof nv === "number") return String(nv);
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage mapping: 8X CRM → this app's pipeline
//
// The left-hand side is exactly what the CRM's Stage Mappings screen lists, in
// its own casing. The right-hand side is lib/stages.ts. Anything not named here
// is left alone rather than guessed at — an unmapped stage must never silently
// become "disqualified".
// ─────────────────────────────────────────────────────────────────────────────

export const CRM_STAGE_TO_STATUS: Record<string, Status> = {
  "fresh leads": "new",
  "cold calls": "contacted",
  "call back": "contacted",
  "no answer": "no_answer",
  "interested": "qualified",
  "set a meeting": "meeting_booked",
  "follow up after meeting": "meeting_done",
  "not interested": "disqualified",
  "low budget": "disqualified",
  "not available": "disqualified",
  // "Red Expo" and "Network" describe where the lead came from, not how it is
  // going, so they carry no pipeline meaning and are intentionally absent.
};

function normalise(label: string): string {
  return label.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** null = the CRM said something we have no mapping for. Caller must log it. */
export function statusFromCrmStage(label: string | null): Status | null {
  if (!label) return null;
  return CRM_STAGE_TO_STATUS[normalise(label)] ?? null;
}

/** Resolve the numeric stage id, once STATUS_ID_TO_STAGE is filled in. */
export function statusFromCrmStatusId(id: unknown): Status | null {
  const n = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
  if (!Number.isFinite(n)) return null;
  return statusFromCrmStage(STATUS_ID_TO_STAGE[n] ?? null);
}

/**
 * Endpoints that might list the stages by id. 8X documents none of them; these
 * follow the shape its own frontend uses, /api/vN/{module}/{controller}.
 */
export const LOOKUP_CANDIDATES = [
  // The one the CRM itself calls to render the Stage Mappings screen. Watching
  // that page load showed it fetch this once and then open the modal with no
  // further request, so the stage list is already inside this response.
  "/api/v1/integrations/settings/schema",
  "/api/v1/leads/statuses",
  "/api/v2/statuses/statuses",
  "/api/v2/lead-statuses/lead-statuses",
  "/api/v4/leads/statuses",
];

/**
 * Find every {id, name} pair anywhere in a JSON tree.
 *
 * The stage list is in there somewhere, but nothing documents the envelope and
 * guessing a path would just fail silently on the next release. Walking for the
 * shape instead of the location survives that.
 */
export function findIdNamePairs(node: unknown, depth = 0, out: { id: unknown; name: string; via: string }[] = [], via = "$"): { id: unknown; name: string; via: string }[] {
  if (depth > 8 || out.length > 400 || !node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findIdNamePairs(v, depth + 1, out, `${via}[${i}]`));
    return out;
  }
  const o = node as Record<string, unknown>;
  const name = ["name", "title", "label", "stage", "status"].map((k) => o[k]).find((v) => typeof v === "string" && v.trim());
  const id = ["id", "status_id", "value", "key"].map((k) => o[k]).find((v) => typeof v === "number" || typeof v === "string");
  if (name !== undefined && id !== undefined) out.push({ id, name: String(name), via });
  for (const [k, v] of Object.entries(o)) findIdNamePairs(v, depth + 1, out, `${via}.${k}`);
  return out;
}

/** Try any path with the API key. Used by the probe only. */
export async function crmTry(method: "GET" | "POST", path: string, body?: unknown) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return rawExported(method, path, payload);
}

export const rawExported = raw;

/**
 * v4 is a DataTables endpoint, not a Laravel paginator: it replies
 * {draw, recordsTotal, recordsFiltered, data} and it pages on `start`/`length`.
 * Eleven other request shapes were ignored in silence — they each returned
 * page one, which counts identically to a page that worked, so the giveaway
 * was the first row id staying put rather than the row count.
 */
export async function crmPage(start: number, length: number) {
  const r = await rawExported("POST", "/api/v4/leads/leads", JSON.stringify({ start, length }));
  if (r.status !== 200) throw new Error(`v4 HTTP ${r.status}`);
  const parsed = JSON.parse(r.text) as { data?: { recordsTotal?: number; data?: unknown[] } };
  return {
    total: parsed.data?.recordsTotal ?? 0,
    rows: (parsed.data?.data ?? []) as Record<string, unknown>[],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing a lead INTO 8X
//
// Everything above reads. This writes, and it exists because one ad account's
// leads never arrive on their own: 8X's Facebook integration is connected to
// the Dlleni page only, so a second Business's leads sit in this app with
// nobody in the CRM to call them. Searching the CRM for one of them returns
// nothing at all.
//
// The endpoint is 8X's own (Settings > Integrations > Website / Custom):
//
//   POST /api/v1/lead_generation/web_form_routings/storeLead
//
// `form_id` is the load-bearing field. It does not identify the lead - it
// selects a WEB FORM ROUTING, and the routing is what decides who the lead is
// assigned to and which interest it is filed under. We send the Meta lead
// form's own id, so one routing per form is all the CRM ever needs.
//
// ONE THING THIS CANNOT DO: there is no leadgen_id on the payload. A lead
// created this way carries no Meta id, so the mirror that reads stages back
// cannot join on one - it falls back to the phone number. That is why the
// phone is normalised on both sides rather than passed through.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_LEAD_PATH = "/api/v1/lead_generation/web_form_routings/storeLead";

/**
 * 20XXXXXXXXXX -> 0XXXXXXXXXX.
 *
 * We store Meta's E.164 digits; the CRM stores and searches the local form the
 * customer actually typed. Sending the stored form creates a lead whose number
 * nobody in the CRM can find by searching it.
 */
export function localEgyptPhone(stored?: string | null): string | null {
  const d = String(stored ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("20")) return `0${d.slice(2)}`;
  return d.startsWith("0") ? d : `0${d}`;
}

export type StoreLeadInput = {
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  /** The routing key - the Meta lead form id. */
  formId?: string | null;
  /** Free text the agent sees on the lead: the form answers, verbatim. */
  description?: string | null;
};

export type StoreLeadResult = { ok: boolean; status: number; body: string };

/**
 * Gulf and Levant buyers are a normal part of Egyptian real estate, and 8X
 * validates the number against the declared country - country_code "EG" on a
 * Jordanian number is a hard 422. Recognise the common prefixes; anything
 * else is declared as what it is by prefix or falls back to EG.
 */
const COUNTRY_BY_PREFIX: [string, string][] = [
  ["20", "EG"], ["962", "JO"], ["965", "KW"], ["966", "SA"], ["968", "OM"],
  ["971", "AE"], ["973", "BH"], ["974", "QA"], ["961", "LB"], ["964", "IQ"], ["218", "LY"],
];

function countryOf(stored?: string | null): string {
  const d = String(stored ?? "").replace(/\D/g, "");
  for (const [prefix, code] of COUNTRY_BY_PREFIX) if (d.startsWith(prefix)) return code;
  return "EG";
}

export async function crmStoreLead(input: StoreLeadInput): Promise<StoreLeadResult> {
  const country = countryOf(input.phone);
  // Egyptian numbers go in the local form people search by; foreign numbers
  // keep their international digits - "0" + a Jordanian number is nothing.
  const phone = country === "EG"
    ? localEgyptPhone(input.phone)
    : String(input.phone ?? "").replace(/\D/g, "");
  const full = (input.fullName ?? "").trim();
  const parts = full.split(/\s+/).filter(Boolean);

  const payload = {
    title: "",
    first_name: parts[0] ?? "",
    middle_name: parts.length > 2 ? parts.slice(1, -1).join(" ") : "",
    last_name: parts.length > 1 ? parts[parts.length - 1] : "",
    full_name: full,
    description: input.description ?? "",
    company: "",
    address: "",
    zip_code: "",
    birthdate: "",
    phones: phone ? [{ phone, country_code: country }] : [],
    // 22 is the account type the API's own example uses for an email address.
    social_accounts: input.email ? [{ social_account: input.email, account_type_id: 22 }] : [],
    form_id: input.formId ?? "",
  };

  const r = await raw("POST", STORE_LEAD_PATH, JSON.stringify(payload));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.text.slice(0, 300) };
}
