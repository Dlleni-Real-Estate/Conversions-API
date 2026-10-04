/**
 * Agents: the people who work routed leads from the agent app.
 *
 * An agent is not a dashboard user. The dashboard runs on two shared
 * passwords; an agent has an account of their own, sees only the leads handed
 * to them, and every stage they set carries their name. So they sign in with a
 * username and password, and get back a token the app keeps.
 *
 * Neither secret is stored as given. Passwords are scrypt-hashed with a salt
 * per agent; tokens are random and only their SHA-256 is kept - a copy of the
 * table is not a set of working logins.
 */

import type { NextRequest } from "next/server";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "./supabase";

type DB = ReturnType<typeof supabaseAdmin>;

const KEYLEN = 64;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function newToken(): { token: string; hash: string } {
  const token = `agt_${randomBytes(32).toString("base64url")}`;
  return { token, hash: tokenHash(token) };
}

/** What the rules for a username are, in one place for the API and the form. */
export function normaliseUsername(v: unknown): string | null {
  const u = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9._-]{2,40}$/.test(u) ? u : null;
}

export const MIN_PASSWORD = 6;

export type Agent = {
  id: string;
  name: string;
  username: string;
  phone: string | null;
  active: boolean;
  available: boolean;
  last_seen_at: string | null;
  app_version: string | null;
};

export const AGENT_COLUMNS = "id,name,username,phone,active,available,last_seen_at,app_version";

/** An agent's app checks in every ~15s; this is how stale "online" may be. */
export const ONLINE_WINDOW_MS = 2 * 60_000;
/** Away this long and coming back counts as a new shift (see rebaseline_agent). */
export const AWAY_MS = 15 * 60_000;

/**
 * The agent behind a request, or null.
 *
 * The token travels in `x-agent-token`, never in `authorization`: that header
 * is the cron's, and the two must never be mistaken for each other.
 * An inactive agent is refused even with a valid token, so switching someone
 * off in the dashboard takes effect on their very next request.
 */
export async function agentFromRequest(req: NextRequest, db: DB = supabaseAdmin()): Promise<Agent | null> {
  const token = req.headers.get("x-agent-token") || "";
  if (!token.startsWith("agt_") || token.length < 40) return null;
  const hash = tokenHash(token);

  const { data: session } = await db
    .from("agent_sessions")
    .select("agent_id,last_used_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!session) return null;

  const { data: agent } = await db.from("agents").select(AGENT_COLUMNS).eq("id", session.agent_id).maybeSingle();
  if (!agent || !(agent as Agent).active) return null;

  // Cheap bookkeeping, at most once a minute per device.
  if (Date.now() - Date.parse(String(session.last_used_at)) > 60_000) {
    await db.from("agent_sessions").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);
  }
  return agent as Agent;
}

/**
 * Record that the agent's app is alive. An agent coming back after a while
 * away is rebaselined first, so they rejoin at their share instead of being
 * owed every lead they missed.
 */
export async function touchPresence(db: DB, agent: Agent, appVersion?: string | null): Promise<void> {
  const last = agent.last_seen_at ? Date.parse(agent.last_seen_at) : 0;
  const now = Date.now();
  if (now - last < 30_000 && (!appVersion || appVersion === agent.app_version)) return;
  if (now - last > AWAY_MS) await db.rpc("rebaseline_agent", { p_agent_id: agent.id });
  await db
    .from("agents")
    .update({ last_seen_at: new Date(now).toISOString(), ...(appVersion ? { app_version: appVersion } : {}) })
    .eq("id", agent.id);
}

export function isOnline(lastSeen: string | null | undefined): boolean {
  return !!lastSeen && Date.now() - Date.parse(lastSeen) < ONLINE_WINDOW_MS;
}
