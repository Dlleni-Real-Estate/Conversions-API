import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isAuthed } from "@/lib/auth";
import { createState, oauthScopes, OAUTH_CONFIGURED } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * Hands the dashboard a Facebook Login URL.
 *
 * A fetch (with the app password) rather than a plain link, so the state nonce
 * is minted only for someone already signed in - the callback later trusts
 * nothing else. The browser then just navigates to the returned URL.
 */
export async function GET(req: NextRequest) {
  if (!isAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!OAUTH_CONFIGURED) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "META_APP_ID / META_APP_SECRET are not set in Vercel, so Facebook Login is unavailable. " +
          "Add them (Settings > Environment Variables), whitelist the callback URL in the Meta app, " +
          "or use the manual-token path below.",
      },
      { status: 400 }
    );
  }

  const nonce = await createState(supabaseAdmin());
  const redirectUri = `https://${req.nextUrl.host}/api/oauth/callback`;
  const url =
    `https://www.facebook.com/${process.env.META_API_VERSION || "v23.0"}/dialog/oauth?` +
    new URLSearchParams({
      client_id: process.env.META_APP_ID || "",
      redirect_uri: redirectUri,
      state: nonce,
      response_type: "code",
      scope: oauthScopes(),
    });

  return NextResponse.json({ ok: true, url });
}
