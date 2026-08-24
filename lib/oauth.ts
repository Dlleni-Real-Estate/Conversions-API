/**
 * Facebook Login for the connect screen.
 *
 * The point of this file is one property: THE TOKEN NEVER REACHES THE BROWSER.
 * The dashboard asks /api/oauth/start for a login URL and navigates to it;
 * Facebook sends the browser back to /api/oauth/callback with a code; the
 * callback - which holds the app secret - turns the code into a long-lived
 * token and parks it server-side under the state nonce; the dashboard then
 * refers to that token by nonce through the already-authenticated
 * /api/ad-accounts endpoint. URLs, browser history and client state only ever
 * carry the nonce, which is worthless without the app password.
 *
 * Long-lived user tokens last ~60 days. token_expires_at is stored on the
 * connection so health can warn BEFORE it lapses; reconnecting is the same
 * two-click login again.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, any, any>;

const GRAPH = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

export const OAUTH_CONFIGURED = Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

/**
 * How long a parked sign-in lives. An hour, because the first cut used fifteen
 * minutes and the account list kept vanishing mid-exploration - switch to the
 * Pipeline tab, come back, gone. The dashboard remembers the nonce per-tab and
 * re-probes quietly, so within this window the list just stays; past it, the
 * server has forgotten the token and the login button is two clicks again.
 */
const TTL_MS = 60 * 60 * 1000;

export function oauthScopes(): string {
  // Everything the per-account calls make: list accounts and datasets
  // (ads_read, business_management), resolve the Page and read its leads
  // (pages_show_list, pages_manage_ads, leads_retrieval), and CREATE a
  // dataset on an account that has none (ads_management) - the one-click
  // replacement for the manual Business Settings walk.
  return "ads_read,ads_management,pages_show_list,pages_manage_ads,leads_retrieval,business_management";
}

export async function createState(db: DB): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  await db.from("app_settings").upsert(
    { key: `oauth_state:${nonce}`, value: { at: Date.now() }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  await purge(db);
  return nonce;
}

/** Single use: reading the state deletes it, so a replayed callback fails. */
export async function consumeState(db: DB, nonce: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return false;
  const { data } = await db
    .from("app_settings").select("value").eq("key", `oauth_state:${nonce}`).maybeSingle();
  await db.from("app_settings").delete().eq("key", `oauth_state:${nonce}`);
  const at = (data?.value as { at?: number } | undefined)?.at;
  return typeof at === "number" && Date.now() - at < TTL_MS;
}

export async function storeToken(db: DB, nonce: string, token: string): Promise<void> {
  await db.from("app_settings").upsert(
    { key: `oauth_token:${nonce}`, value: { at: Date.now(), token }, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

/** Sign-out: drop the parked token and its state, before the TTL does. */
export async function forgetToken(db: DB, nonce: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return;
  await db.from("app_settings").delete().eq("key", `oauth_token:${nonce}`);
  await db.from("app_settings").delete().eq("key", `oauth_state:${nonce}`);
}

/** NOT single use: one login can connect several accounts before the TTL. */
export async function tokenForNonce(db: DB, nonce: string): Promise<string | null> {
  if (!/^[a-f0-9]{32}$/.test(nonce)) return null;
  const { data } = await db
    .from("app_settings").select("value").eq("key", `oauth_token:${nonce}`).maybeSingle();
  const v = data?.value as { at?: number; token?: string } | undefined;
  if (!v?.token || typeof v.at !== "number" || Date.now() - v.at >= TTL_MS) return null;
  return v.token;
}

async function purge(db: DB): Promise<void> {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  await db.from("app_settings").delete().like("key", "oauth_state:%").lt("updated_at", cutoff);
  await db.from("app_settings").delete().like("key", "oauth_token:%").lt("updated_at", cutoff);
}

/** code -> short-lived token -> long-lived token (~60 days). */
export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const clientId = process.env.META_APP_ID || "";
  const secret = process.env.META_APP_SECRET || "";

  const r = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({ client_id: clientId, client_secret: secret, redirect_uri: redirectUri, code })
  );
  const j = (await r.json().catch(() => ({}))) as {
    access_token?: string; error?: { message?: string };
  };
  if (!r.ok || j.error || !j.access_token) {
    throw new Error(j.error?.message || `code exchange failed (HTTP ${r.status})`);
  }

  const r2 = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token", client_id: clientId, client_secret: secret,
        fb_exchange_token: j.access_token,
      })
  );
  const j2 = (await r2.json().catch(() => ({}))) as { access_token?: string };
  // If the long-lived exchange hiccups, the short-lived token still works for
  // the connect flow; it just expires sooner and health will say so.
  return (r2.ok && j2.access_token) || j.access_token;
}

/**
 * Try to renew a long-lived token BEFORE it dies, with the same exchange that
 * minted it. Meta sometimes answers with the very same token (nothing gained,
 * nothing lost) and sometimes with a fresh 60-day one; when the exchange stops
 * working the health warning still stands and a two-click re-login remains
 * the fallback. Called by the hourly cron for tokens inside the warning
 * window, so a healthy setup never actually reaches expiry.
 */
export async function refreshLongLivedToken(oldToken: string): Promise<{ token: string; expiresAt: string | null } | null> {
  if (!OAUTH_CONFIGURED) return null;
  try {
    const r = await fetch(
      `${GRAPH}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: process.env.META_APP_ID || "",
          client_secret: process.env.META_APP_SECRET || "",
          fb_exchange_token: oldToken,
        })
    );
    const j = (await r.json().catch(() => ({}))) as { access_token?: string };
    if (!r.ok || !j.access_token) return null;
    const expiresAt = await tokenExpiry(j.access_token);
    return { token: j.access_token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Renew every stored token that dies within ten days. Lives here - not in a
 * route - because the only guaranteed scheduler this deployment has is the
 * /api/sync pinger; the replay route calls this too, but nothing proves
 * anything calls the replay route. Belt and suspenders, cheap on both.
 */
export async function renewExpiringTokens(): Promise<{ checked: number; refreshed: number; failed: number }> {
  const db = supabaseAdmin();
  const horizon = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
  const { data: rows } = await db
    .from("ad_accounts")
    .select("ad_account_id, access_token, token_expires_at")
    .not("access_token", "is", null)
    .not("token_expires_at", "is", null)
    .lt("token_expires_at", horizon);

  let refreshed = 0;
  let failed = 0;
  for (const r of rows ?? []) {
    const renewed = await refreshLongLivedToken(r.access_token as string);
    const newExpiry = renewed ? renewed.expiresAt ?? (await tokenExpiry(renewed.token)) : null;
    // A same-token answer with the same horizon is not a renewal.
    if (renewed && newExpiry && newExpiry > (r.token_expires_at as string)) {
      await db
        .from("ad_accounts")
        .update({ access_token: renewed.token, token_expires_at: newExpiry, last_error: null })
        .eq("ad_account_id", r.ad_account_id);
      refreshed++;
      console.log(`[token] renewed for ${r.ad_account_id}: now expires ${newExpiry.slice(0, 10)}`);
    } else {
      failed++;
      await db
        .from("ad_accounts")
        .update({ last_error: "token auto-renew declined by Meta - renew with Facebook Login" })
        .eq("ad_account_id", r.ad_account_id);
      console.warn(`[token] auto-renew declined for ${r.ad_account_id}`);
    }
  }
  return { checked: rows?.length ?? 0, refreshed, failed };
}

/**
 * When this token dies, from Meta's own debug endpoint. Null means "no expiry"
 * (a system-user token) or "could not tell" - debug_token can only inspect
 * tokens minted by OUR app, so a system user generated under another Business's
 * app comes back unknown, which is fine: unknown never triggers a false alarm.
 */
export async function tokenExpiry(token: string): Promise<string | null> {
  if (!OAUTH_CONFIGURED) return null;
  try {
    const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
    const r = await fetch(
      `${GRAPH}/debug_token?` + new URLSearchParams({ input_token: token, access_token: appToken })
    );
    const j = (await r.json().catch(() => ({}))) as { data?: { expires_at?: number } };
    const exp = j.data?.expires_at;
    if (typeof exp === "number" && exp > 0) return new Date(exp * 1000).toISOString();
    return null;
  } catch {
    return null;
  }
}
