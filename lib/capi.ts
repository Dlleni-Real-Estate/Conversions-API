/**
 * Conversions API — CRM / Lead Ads integration.
 *
 * POST https://graph.facebook.com/<ver>/<DATASET_ID>/events
 *
 * The join key is `user_data.lead_id` — Meta's own 15-17 digit leadgen id, sent
 * RAW (it is a Meta identifier, so unlike email/phone it must NOT be hashed).
 * `action_source: "system_generated"` is what marks the event as coming from a
 * CRM rather than a browser.
 *
 * Every event carries an `event_id` we generate deterministically
 * (lead_id + event_name) so replays and double-clicks dedupe instead of
 * inflating the numbers.
 */

import { createHash } from "crypto";
import { metaConfig, normalizeEgyptPhone } from "./meta";
import { supabaseAdmin } from "./supabase";

const GRAPH = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

const sha256 = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

export type CapiInput = {
  leadId: string;
  eventName: string;
  eventTime?: Date;
  phone?: string;
  email?: string;
  value?: number | null;
  currency?: string;
};

export function buildEvent(input: CapiInput) {
  const t = input.eventTime ?? new Date();

  const user_data: Record<string, unknown> = { lead_id: input.leadId };
  // Extra match keys are optional when lead_id is present, but they raise Event
  // Match Quality and give Meta a fallback if the lead_id ever fails to resolve.
  const ph = normalizeEgyptPhone(input.phone);
  if (ph) user_data.ph = [sha256(ph)];
  if (input.email) user_data.em = [sha256(input.email)];

  // Meta's CRM / Conversion Leads contract: without these two, the event is
  // accepted (200, events_received: 1) but treated as a plain custom event and
  // never feeds the Conversion Leads optimisation. They must ALWAYS be present,
  // not only when there is a deal value.
  const custom_data: Record<string, unknown> = {
    lead_event_source: process.env.META_LEAD_EVENT_SOURCE || "Dlleni CRM",
    event_source: "crm",
  };
  if (input.value != null && Number.isFinite(input.value)) {
    custom_data.value = input.value;
    custom_data.currency = input.currency || "EGP";
  }

  return {
    event_name: input.eventName,
    event_time: Math.floor(t.getTime() / 1000),
    event_id: `${input.leadId}:${input.eventName}`,
    action_source: "system_generated",
    user_data,
    custom_data,
  };
}

export type SendResult = { ok: true; response: unknown } | { ok: false; error: string; response?: unknown };

async function postEvents(events: unknown[]): Promise<SendResult> {
  const { token, datasetId, testEventCode } = metaConfig();

  const body: Record<string, unknown> = { data: events };
  if (testEventCode) body.test_event_code = testEventCode;

  try {
    const res = await fetch(`${GRAPH}/${datasetId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: token }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json as { error?: unknown }).error) {
      const e = (json as { error?: { message?: string; code?: number } }).error;
      return { ok: false, error: e?.message || `HTTP ${res.status}`, response: json };
    }
    return { ok: true, response: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build the event, log it, ship it, record the outcome. The row in capi_events
 * is written BEFORE the network call, so a crash mid-flight leaves a 'pending'
 * row that /api/capi/replay will pick up rather than a silently lost event.
 */
export async function sendLeadEvent(input: CapiInput): Promise<SendResult> {
  const db = supabaseAdmin();
  const event = buildEvent(input);
  const eventTime = new Date((event.event_time as number) * 1000).toISOString();

  const { data: row } = await db
    .from("capi_events")
    .upsert(
      {
        lead_id: input.leadId,
        event_name: input.eventName,
        event_id: event.event_id,
        event_time: eventTime,
        payload: event,
        status: "pending",
      },
      { onConflict: "event_id" }
    )
    .select("id, attempts")
    .single();

  const result = await postEvents([event]);

  if (row?.id) {
    await db
      .from("capi_events")
      .update({
        status: result.ok ? "sent" : "failed",
        response: "response" in result ? (result.response as object) : null,
        last_error: result.ok ? null : result.error,
        attempts: (row.attempts ?? 0) + 1,
        sent_at: result.ok ? new Date().toISOString() : null,
      })
      .eq("id", row.id);
  }

  return result;
}

/**
 * Ship many events in one call. Meta caps a batch at 1,000 events and discards
 * the WHOLE batch on an error inside it, so we keep chunks small and let a bad
 * chunk fail on its own without taking the good ones with it.
 *
 * Used for the raw-lead stage, where a backfill can mean hundreds of events and
 * one-at-a-time would time the function out.
 */
export async function sendLeadEvents(inputs: CapiInput[], chunkSize = 100) {
  if (inputs.length === 0) return { attempted: 0, sent: 0, failed: 0 };
  const db = supabaseAdmin();
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < inputs.length; i += chunkSize) {
    const slice = inputs.slice(i, i + chunkSize);
    const events = slice.map(buildEvent);

    // Logged before the network call, so a crash mid-flight leaves rows the
    // replay cron can pick up rather than events that quietly never happened.
    await db.from("capi_events").upsert(
      events.map((e, n) => ({
        lead_id: slice[n].leadId,
        event_name: slice[n].eventName,
        event_id: e.event_id,
        event_time: new Date((e.event_time as number) * 1000).toISOString(),
        payload: e,
        status: "pending",
      })),
      { onConflict: "event_id" }
    );

    const result = await postEvents(events);
    const patch = {
      status: result.ok ? "sent" : "failed",
      response: "response" in result ? (result.response as object) : null,
      last_error: result.ok ? null : result.error,
      sent_at: result.ok ? new Date().toISOString() : null,
    };
    await db
      .from("capi_events")
      .update(patch)
      .in("event_id", events.map((e) => e.event_id));

    if (result.ok) sent += slice.length;
    else failed += slice.length;
  }

  return { attempted: inputs.length, sent, failed };
}

/** Retry anything left pending/failed. Called by the hourly cron. */
export async function replayFailed(limit = 100) {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("capi_events")
    .select("id, payload, attempts")
    .in("status", ["pending", "failed"])
    .lt("attempts", 6)
    .order("created_at", { ascending: true })
    .limit(limit);

  let sent = 0;
  let failed = 0;

  for (const row of rows || []) {
    const result = await postEvents([row.payload]);
    if (result.ok) sent++;
    else failed++;
    await db
      .from("capi_events")
      .update({
        status: result.ok ? "sent" : "failed",
        response: "response" in result ? (result.response as object) : null,
        last_error: result.ok ? null : result.error,
        attempts: (row.attempts ?? 0) + 1,
        sent_at: result.ok ? new Date().toISOString() : null,
      })
      .eq("id", row.id);
  }

  return { considered: rows?.length ?? 0, sent, failed };
}
