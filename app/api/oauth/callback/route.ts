import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { consumeState, exchangeCode, storeToken } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * Where Facebook sends the browser back.
 *
 * No app password arrives here - the browser comes bare - so the only thing
 * trusted is the single-use state nonce this app minted minutes earlier. The
 * endpoint turns the code into a long-lived token, parks it SERVER-SIDE under
 * the nonce, and bounces to the dashboard with only the nonce in the URL. The
 * token itself never appears in a URL, a redirect, or the browser at all;
 * retrieving it requires the app password, through /api/ad-accounts.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (qs: string) => NextResponse.redirect(new URL(`/?${qs}`, req.nextUrl.origin));

  const denied = q.get("error_description") || q.get("error");
  if (denied) return back(`oauth_error=${encodeURIComponent(denied)}`);

  const code = q.get("code");
  const state = q.get("state") || "";
  const db = supabaseAdmin();

  if (!code || !(await consumeState(db, state))) {
    return back("oauth_error=" + encodeURIComponent("sign-in expired or was tampered with - try again"));
  }

  try {
    const token = await exchangeCode(code, `https://${req.nextUrl.host}/api/oauth/callback`);
    await storeToken(db, state, token);
    return back(`oauth_done=${state}`);
  } catch (err) {
    return back(`oauth_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
}
