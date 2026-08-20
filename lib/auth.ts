import { NextRequest } from "next/server";

/**
 * Two gates:
 *  - Vercel Cron calls carry `Authorization: Bearer $CRON_SECRET` automatically.
 *  - Humans hitting the dashboard/API send `x-app-password`.
 * Both are constant-time compared.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function isCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  return safeEqual(header, `Bearer ${secret}`);
}

export function isAuthed(req: NextRequest): boolean {
  if (isCron(req)) return true;
  const pw = process.env.APP_PASSWORD;
  if (!pw) return false;
  const given = req.headers.get("x-app-password") || "";
  return safeEqual(given, pw);
}
