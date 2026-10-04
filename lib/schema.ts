/**
 * Has migration 0015 (agents and routing) reached this database yet?
 *
 * The code can be deployed before the migration is run - and on a team where
 * the migration is pasted into Supabase by hand, it will be. Every query that
 * reads one of 0015's columns asks here first, so until the migration runs the
 * dashboard and the sync behave exactly as they did before it existed, and the
 * moment it runs everything new switches on by itself, no second deploy.
 *
 * Probed once a minute per server instance: one tiny query, and "no" is never
 * cached for long, so a migration run mid-day is picked up within a minute.
 */

import { supabaseAdmin } from "./supabase";

type DB = ReturnType<typeof supabaseAdmin>;

let cache: { at: number; ready: boolean } | null = null;

export async function agentsSchemaReady(db: DB): Promise<boolean> {
  if (cache && Date.now() - cache.at < 60_000) return cache.ready;
  const { error } = await db.from("leads").select("is_test,agent_id").limit(1);
  cache = { at: Date.now(), ready: !error };
  return cache.ready;
}
