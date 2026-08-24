import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import {
  accountBusiness, businessAccountIds, businessPages, createDataset, datasetsForAccount,
  grantedBusinesses, listAdAccounts, pagesForAccount, tokenOwnerName, verifyPairing,
} from "@/lib/meta";
import { isAdmin } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { forgetToken, tokenExpiry, tokenForNonce } from "@/lib/oauth";

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

  const { data: connectedRaw } = await db
    .from("ad_accounts").select("*").order("created_at", { ascending: true });

  // The stored token never leaves the server. The UI only needs to know that
  // one exists, so the row is replaced by has_own_token before it is returned.
  const connected = (connectedRaw ?? []).map((r) => {
    const { access_token, ...rest } = r as { access_token?: string | null } & Record<string, unknown>;
    return { ...rest, has_own_token: Boolean(access_token) };
  });

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
  // Fetched ONLY for accounts that could still be connected - the connected
  // ones never render a picker, so paying two or three Graph calls each for
  // them was pure Settings-tab latency. The "user" Page fallback narrows
  // through the account's Business where one exists, same as the login
  // picker: the whole personal Page list is where wrong-Page mistakes live.
  const connectedIdSet = new Set(connected.map((c) => String((c as Record<string, unknown>).ad_account_id)));
  const candidates = available.filter((a) => !connectedIdSet.has(a.id));

  const datasets: Record<string, { id: string; name?: string }[]> = {};
  const pages: Record<string, { id: string; name?: string }[]> = {};
  const pageSource: Record<string, string> = {};
  await Promise.all(
    candidates.map(async (a) => {
      const [d, p] = await Promise.all([
        datasetsForAccount(a.id).catch(() => []),
        pagesForAccount(a.id).catch(() => ({ pages: [] as { id: string; name?: string }[], source: "none" as const })),
      ]);
      datasets[a.id] = d;
      if (p.source === "user") {
        const biz = await accountBusiness(a.id).catch(() => ({}) as { id?: string });
        if (biz.id) {
          const bp = await businessPages(biz.id).catch(() => []);
          if (bp.length > 0) {
            pages[a.id] = bp;
            pageSource[a.id] = "business";
            return;
          }
        }
      }
      pages[a.id] = p.pages;
      pageSource[a.id] = p.source;
    })
  );

  return NextResponse.json({
    ok: true,
    connected,
    available,
    datasets,
    pages,
    pageSource,
    envPageId: process.env.META_PAGE_ID || null,
    listError,
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = supabaseAdmin();
  const body = (await req.json().catch(() => null)) as {
    ad_account_id?: string; dataset_id?: string; page_id?: string; name?: string; enabled?: boolean;
    access_token?: string; probe_token?: string; oauth_nonce?: string;
    create_dataset?: boolean; dataset_name?: string; oauth_signout?: string;
  } | null;

  // Sign-out: forget the parked token now instead of waiting out its hour.
  // The next login starts clean - which is also how a NEW permission added to
  // the scope gets its consent screen shown.
  const signoutNonce = (body?.oauth_signout || "").trim();
  if (signoutNonce) {
    await forgetToken(db, signoutNonce);
    return NextResponse.json({ ok: true, signed_out: true });
  }

  // A Facebook Login hands the browser a nonce, never the token; the token
  // sits server-side under that nonce for a few minutes. Resolving it here
  // (behind the app password) is the only way it comes back out.
  const oauthNonce = (body?.oauth_nonce || "").trim();
  const nonceToken = oauthNonce ? await tokenForNonce(db, oauthNonce) : null;
  if (oauthNonce && !nonceToken) {
    return NextResponse.json(
      { ok: false, error: "The Facebook sign-in expired. Sign in again and retry." },
      { status: 400 }
    );
  }

  // Probe: "what can THIS token see?" - for connecting an account that lives
  // in another Business, whose assets the deployment token cannot list. The
  // token is used for the three read calls and returned to no one.
  const probeToken = (body?.probe_token || "").trim() || (!body?.ad_account_id && nonceToken ? nonceToken : "");
  if (probeToken) {
    try {
      // Businesses FIRST: they are the reliable grouping signal (the business
      // field on the account list comes back empty under granular consent),
      // and the per-account Page list is resolved THROUGH them - an account's
      // Business owns the Pages that could plausibly run its lead forms.
      const [available, signedInAs, businesses] = await Promise.all([
        listAdAccounts(probeToken),
        tokenOwnerName(probeToken),
        grantedBusinesses(probeToken),
      ]);
      const bizOf = new Map<string, { id: string; name?: string }>();
      await Promise.all(
        businesses.map(async (b) => {
          for (const id of await businessAccountIds(b.id, probeToken)) bizOf.set(id, b);
        })
      );
      for (const a of available) {
        if (!a.business_id && bizOf.has(a.id)) {
          const b = bizOf.get(a.id)!;
          a.business_id = b.id;
          a.business_name = b.name;
        }
      }

      const bizPagesCache = new Map<string, { id: string; name?: string }[]>();
      const pagesOfBusiness = async (bizId: string) => {
        if (!bizPagesCache.has(bizId)) bizPagesCache.set(bizId, await businessPages(bizId, probeToken));
        return bizPagesCache.get(bizId)!;
      };

      const datasets: Record<string, { id: string; name?: string }[]> = {};
      const pages: Record<string, { id: string; name?: string }[]> = {};
      const pageSource: Record<string, string> = {};
      await Promise.all(
        available.map(async (a) => {
          const [d, p] = await Promise.all([
            datasetsForAccount(a.id, probeToken).catch(() => []),
            pagesForAccount(a.id, probeToken).catch(
              () => ({ pages: [] as { id: string; name?: string }[], source: "none" as const })
            ),
          ]);
          datasets[a.id] = d;
          if (p.source === "account") {
            pages[a.id] = p.pages;
            pageSource[a.id] = "account";
          } else if (a.business_id) {
            // Narrow the fallback to the Pages this account's Business owns
            // or manages - not the signed-in user's entire fourteen-Page life.
            const bp = await pagesOfBusiness(a.business_id);
            pages[a.id] = bp.length > 0 ? bp : p.pages;
            pageSource[a.id] = bp.length > 0 ? "business" : p.source;
          } else {
            pages[a.id] = p.pages;
            pageSource[a.id] = p.source;
          }
        })
      );

      return NextResponse.json({
        ok: true, probe: true, available, datasets, pages, pageSource, signedInAs, businesses,
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 }
      );
    }
  }

  const accountId = (body?.ad_account_id || "").replace(/^act_/, "").trim();
  if (!accountId) return NextResponse.json({ error: "ad_account_id is required" }, { status: 400 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });

  // Toggle: no re-verification, because the pairing did not change.
  if (typeof body?.enabled === "boolean" && !body.dataset_id) {
    const { error } = await db.from("ad_accounts").update({ enabled: body.enabled }).eq("ad_account_id", accountId);
    await logAudit(req, body.enabled ? "account_resume" : "account_pause", accountId);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, ad_account_id: accountId, enabled: body.enabled });
  }

  let datasetId = (body?.dataset_id || "").trim();

  // One click instead of the Business Settings walk: create the dataset ON
  // the ad account. Born connected, so the verification below passes by
  // construction - and if it somehow does not, nothing was stored.
  if (!datasetId && body?.create_dataset) {
    const created = await createDataset(
      accountId,
      (body?.dataset_name || "").trim() || `${(body?.name || "CRM").trim()} - Lead Events`,
      (body?.access_token || "").trim() || nonceToken || undefined
    );
    if ("error" in created) {
      return NextResponse.json(
        { ok: false, error: `Could not create a dataset on ${accountId}: ${created.error}` },
        { status: 400 }
      );
    }
    datasetId = created.id;
    await logAudit(req, "dataset_create", accountId, { dataset_id: datasetId });
  }

  if (!datasetId) return NextResponse.json({ error: "dataset_id is required" }, { status: 400 });

  // An account from another Business carries its own token, and THAT token is
  // the one the pairing is verified with - the same one every later call for
  // this account will use. Verifying with one token and sending with another
  // would re-open the exact hole verification exists to close.
  const ownToken = (body?.access_token || "").trim() || nonceToken || null;

  // When this token dies, so health can warn BEFORE the account goes quiet.
  // Null means "never" (a system user) or "could not tell" - either way, no
  // false alarms.
  const tokenExpiresAt = ownToken ? await tokenExpiry(ownToken) : undefined;

  const check = await verifyPairing(accountId, datasetId, ownToken ?? undefined).catch((err) => ({
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
    const p = await pagesForAccount(accountId, ownToken ?? undefined).catch(
      () => ({ pages: [] as { id: string; name?: string }[], source: "none" as const })
    );
    if (p.pages.length === 1) pageId = p.pages[0].id;
    else if (p.pages.length === 0) {
      if (ownToken) {
        // The env Page belongs to the env token's Business; an own-token
        // account can never read leads through it. No candidates means the
        // token was not granted the Page, and that has to be fixed, not
        // papered over.
        return NextResponse.json(
          {
            ok: false,
            error:
              `The provided token cannot see any Page. In that Business, assign the Page that owns ` +
              `this account's lead forms to the token's system user (with pages_show_list + ` +
              `pages_manage_ads + leads_retrieval), then connect again.`,
          },
          { status: 400 }
        );
      }
      pageId = process.env.META_PAGE_ID || "";
    }
    else {
      // More than one candidate and no instruction. Picking one here would be
      // a guess that reads zero leads and reports nothing, so it is refused
      // and the candidates are handed back for a human to choose from.
      return NextResponse.json(
        {
          ok: false,
          error:
            p.source === "account"
              ? `Ad account ${accountId} advertises ${p.pages.length} Pages. Choose which one owns the lead forms.`
              : `Meta ties no Page to ad account ${accountId}. Choose which of your Pages owns its lead forms.`,
          pages: p.pages,
          pageSource: p.source,
        },
        { status: 400 }
      );
    }
  }

  // Asked of Meta with the connect token, not trusted from the client: the
  // Business name on the row is what tells two same-named campaigns apart on
  // every screen after this one.
  const biz = await accountBusiness(accountId, ownToken ?? undefined);
  let bizId = biz.id ?? null;
  let bizName = biz.name ?? null;
  if (!bizId && ownToken) {
    // Same consent quirk as the picker: the account object may hide its
    // Business while the granted-Business side still names it.
    for (const b of await grantedBusinesses(ownToken)) {
      if ((await businessAccountIds(b.id, ownToken)).includes(accountId)) {
        bizId = b.id;
        bizName = b.name ?? null;
        break;
      }
    }
  }

  const { error } = await db.from("ad_accounts").upsert(
    {
      ad_account_id: accountId,
      name: body?.name ?? null,
      business_id: bizId,
      business_name: bizName,
      dataset_id: datasetId,
      dataset_name: check.datasetName ?? null,
      page_id: pageId || null,
      enabled: body?.enabled ?? true,
      verified_at: new Date().toISOString(),
      last_error: null,
      // Only written when provided, so re-verifying an account later without
      // re-pasting its token does not wipe the stored one.
      ...(ownToken ? { access_token: ownToken, token_expires_at: tokenExpiresAt } : {}),
    },
    { onConflict: "ad_account_id" }
  );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  await logAudit(req, "account_connect", accountId, {
    dataset_id: datasetId, page_id: pageId || null, own_token: Boolean(ownToken),
  });

  return NextResponse.json({
    ok: true, ad_account_id: accountId, dataset_id: datasetId, page_id: pageId || null, verified: true,
  });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(req)) return NextResponse.json({ error: "viewer access is read-only" }, { status: 403 });
  const accountId = (req.nextUrl.searchParams.get("ad_account_id") || "").replace(/^act_/, "");
  if (!accountId) return NextResponse.json({ error: "ad_account_id is required" }, { status: 400 });

  // The leads already stored keep their ad_account_id: history stays readable
  // after a disconnect, and reconnecting later picks up exactly where it left.
  const { error } = await supabaseAdmin().from("ad_accounts").delete().eq("ad_account_id", accountId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  await logAudit(req, "account_disconnect", accountId);
  return NextResponse.json({ ok: true, ad_account_id: accountId, removed: true });
}
