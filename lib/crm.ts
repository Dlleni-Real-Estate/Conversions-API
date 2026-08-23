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
 * Left empty until the ids are read off real leads: an id mapped by guesswork
 * would quietly file live leads under the wrong stage, and that error would
 * reach Meta as optimisation signal before anyone noticed it on a screen.
 */
export const STATUS_ID_TO_STAGE: Record<number, string> = {};

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

export function pickPhone(row: Record<string, unknown>): string | null {
  for (const k of PHONE_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
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
