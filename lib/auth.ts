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

export type Role = "admin" | "viewer" | "cron";

/**
 * Two passwords, two roles. APP_PASSWORD is the full-control password;
 * APP_PASSWORD_VIEWER (optional) opens every read-only screen for the team
 * and nothing else. Mutating endpoints demand isAdmin; everything else takes
 * either. The comparison stays constant-time for both.
 */
export function roleOf(req: NextRequest): Role | null {
  if (isCron(req)) return "cron";
  const given = req.headers.get("x-app-password") || "";
  const admin = process.env.APP_PASSWORD;
  if (admin && safeEqual(given, admin)) return "admin";
  const viewer = process.env.APP_PASSWORD_VIEWER;
  if (viewer && safeEqual(given, viewer)) return "viewer";
  return null;
}

export function isAuthed(req: NextRequest): boolean {
  return roleOf(req) !== null;
}

/** The cron writes as part of its job, so it counts as admin. */
export function isAdmin(req: NextRequest): boolean {
  const r = roleOf(req);
  return r === "admin" || r === "cron";
}
