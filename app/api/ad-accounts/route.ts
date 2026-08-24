import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { datasetsForAccount, listAdAccounts, pagesForAccount, verifyPairing } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Connecting and disconnecting ad accounts.
 *
 * The one rule this endpoint exists to enforce: an account is never stored
 * against a dataset without asking Meta whether the two are actually connected.
 * A dataset that is not connected to the account still answers HTTP 200 with
 * events_received: 1, so an unverified pairing looks identical to a working one
 * from every screen there is. The old code prevented that by hard-coding a
 * single pair; this prevents it by refusing to save an unverified one.
 *
 * GET   — accounts on the token, which are connected here, and the datasets
 *         Meta reports for each, so the picker can only offer real pairings.
 * POST  — { ad_account_id, dataset_id, page_id?, name? } verify, then save.
 *         { ad_account_id, enabled }                     toggle in place.
 * DELETE— ?ad_account_id=…  forget it entirely.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();

  const { data: connected } = await db
    .from("ad_accounts").select("*").order("created_at", { ascending: true });

  let available: { id: string; name?: string; currency?: string; status?: number }[] = [];
  let listError: string | null = null;
  try {
    available = await listAdAccounts();
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err);
  }

  // Datasets per account, so the UI can say "this one has none" before the user
  // commits to it rather than after a week of silently unattributed events.
  // Pages per account for the same reason: leads are read on a Page-scoped
  // edge, so the wrong Page means campaigns list, insights report, and no lead
  // ever arrives - with nothing anywhere saying why.
  const datasets: Record<string, { id: string; name?: string }[]> = {};
  const pages: Record<string, { id: string; name?: string }[]> = {};
  await Promise.all(
    available.map(async (a) => {
      const [d, p] = await Promise.all([
        datasetsForAccount(a.id).catch(() => []),
        pagesForAccount(a.id).catch(() => []),
      ]);
      datasets[a.id] = d;
      pages[a.id] = p;
    })
  );

  return NextResponse.json({
    ok: true,
    connected: connected ?? [],
    available,
    datasets,
    pages,
    envPageId: process.env.META_PAGE_ID || null,
    listError,
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const body = (await req.json().catch(() => null)) as {
    ad_account_id?: string; dataset_id?: string; page_id?: string; name?: string; enabled?: boolean;
  } | null;

  const accountId = (body?.ad_account_id || "").replace(/^act_/, "").trim();
  if (!accountId) return NextResponse.json({ error: "ad_account_id is required" }, { status: 400 });

  // Toggle: no re-verification, because the pairing did not change.
  if (typeof body?.enabled === "boolean" && !body.dataset_id) {
    const { error } = await db.from("ad_accounts").update({ enabled: body.enabled }).eq("ad_account_id", accountId);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, ad_account_id: accountId, enabled: body.enabled });
  }

  const datasetId = (body?.dataset_id || "").trim();
  if (!datasetId) return NextResponse.json({ error: "dataset_id is required" }, { status: 400 });

  const check = await verifyPairing(accountId, datasetId).catch((err) => ({
    ok: false as const, error: err instanceof Error ? err.message : String(err), available: [],
  }));

  if (!check.ok) {
    // Recorded on the row when one exists, so the reason survives the response.
    await db.from("ad_accounts").update({ last_error: check.error, verified_at: null }).eq("ad_account_id", accountId);
    return NextResponse.json({ ok: false, error: check.error, available: check.available }, { status: 400 });
  }

  // The Page the lead forms live on. Asked of Meta rather than inherited from
  // the environment: a second ad account usually advertises a different Page,
  // and inheriting the first one produces a connection that reads zero leads
  // forever without ever reporting an error.
  let pageId = (body?.page_id || "").trim();
  if (!pageId) {
    const pages = await pagesForAccount(accountId).catch(() => []);
    if (pages.length === 1) pageId = pages[0].id;
    else if (pages.length === 0) pageId = process.env.META_PAGE_ID || "";
    else {
      return NextResponse.json(
        {
          ok: false,
          error: `Ad account ${accountId} advertises ${pages.length} Pages. Choose which one owns the lead forms.`,
          pages,
        },
        { status: 400 }
      );
    }
  }

  const { error } = await db.from("ad_accounts").upsert(
    {
      ad_account_id: accountId,
      name: body?.name ?? null,
      dataset_id: datasetId,
      dataset_name: check.datasetName ?? null,
      page_id: pageId || null,
      enabled: body?.enabled ?? true,
      verified_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "ad_account_id" }
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true, ad_account_id: accountId, dataset_id: datasetId, page_id: pageId || null, verified: true,
  });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const accountId = (req.nextUrl.searchParams.get("ad_account_id") || "").replace(/^act_/, "");
  if (!accountId) return NextResponse.json({ error: "ad_account_id is required" }, { status: 400 });

  // The leads already stored keep their ad_account_id: history stays readable
  // after a disconnect, and reconnecting later picks up exactly where it left.
  const { error } = await supabaseAdmin().from("ad_accounts").delete().eq("ad_account_id", accountId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, ad_account_id: accountId, removed: true });
}
