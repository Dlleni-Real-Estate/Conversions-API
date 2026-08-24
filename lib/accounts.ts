/**
 * Which ad accounts the system is actually working with, defined ONCE.
 *
 * This file exists because of a bug that cost us 28 wrong events: the same
 * decision was written out in two places, the two copies drifted, and nothing
 * about the output looked wrong until the numbers were counted by hand. Any
 * rule that more than one route needs lives here now, not in each route.
 *
 * The rule:
 *
 *   ad_accounts has rows  ->  the table is the truth. Only rows that are
 *                             enabled AND verified against Meta are used.
 *   ad_accounts is empty  ->  fall back to the environment's single account,
 *                             so a deployment that has not run the migration
 *                             behaves exactly as it did before.
 *
 * The table stays authoritative even when every row is filtered out. Falling
 * back to the environment in that case would quietly resurrect an account the
 * user had just disabled - the opposite of what they asked for.
 *
 * `verified_at` is the load-bearing column. A dataset that is NOT connected to
 * an ad account still answers HTTP 200 with events_received: 1 and attributes
 * nothing, so an unverified pairing is indistinguishable from a working one
 * from every screen there is. It has to be refused at the source.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { envScope, type AccountScope } from "./meta";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, any, any>;

export type SkippedAccount = {
  adAccountId: string;
  name?: string;
  reason: "unverified" | "disabled";
};

export type ActiveAccounts = {
  scopes: AccountScope[];
  /** Where the answer came from - worth reporting, since they behave differently. */
  source: "table" | "env";
  /** Named, not silently dropped: a skipped account explains a missing campaign. */
  skipped: SkippedAccount[];
};

type Row = {
  ad_account_id: string;
  name: string | null;
  dataset_id: string;
  page_id: string | null;
  enabled: boolean;
  verified_at: string | null;
  /** Set for accounts in another Business; null means the deployment token. */
  access_token: string | null;
};

export async function activeAccounts(db: DB): Promise<ActiveAccounts> {
  const { data, error } = await db
    .from("ad_accounts")
    .select("ad_account_id,name,dataset_id,page_id,enabled,verified_at,access_token")
    .order("created_at", { ascending: true });

  // No table yet (migration not run) is the same situation as no rows: the
  // environment's account is all there is.
  if (error || !data || data.length === 0) {
    return { scopes: [envScope()], source: "env", skipped: [] };
  }

  const rows = data as Row[];
  const skipped: SkippedAccount[] = [];
  const scopes: AccountScope[] = [];

  for (const r of rows) {
    if (!r.enabled) {
      skipped.push({ adAccountId: r.ad_account_id, name: r.name ?? undefined, reason: "disabled" });
      continue;
    }
    if (!r.verified_at) {
      skipped.push({ adAccountId: r.ad_account_id, name: r.name ?? undefined, reason: "unverified" });
      continue;
    }
    scopes.push({
      adAccountId: r.ad_account_id,
      datasetId: r.dataset_id,
      pageId: r.page_id || process.env.META_PAGE_ID || "",
      name: r.name ?? undefined,
      token: r.access_token ?? undefined,
    });
  }

  return { scopes, source: "table", skipped };
}

/** ad_account_id -> full scope, when the caller needs dataset AND token. */
export function scopeIndex(scopes: AccountScope[]): Map<string, AccountScope> {
  return new Map(scopes.map((s) => [s.adAccountId, s]));
}
