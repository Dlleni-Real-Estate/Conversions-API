/**
 * Which system sends stage events to Meta.
 *
 * Exactly one may send. Two senders on one dataset means the same lead reaches
 * the same stage twice, and the funnel Meta trains on is quietly wrong — there
 * is no screen anywhere that would show you that, which is why this is a switch
 * in code rather than something for someone to remember.
 *
 *   "app"  — this app sends them, driven by its own pipeline. The default, and
 *            what to fall back to if the CRM's integration turns out not to
 *            carry `lead_id` or not to let you name the stages.
 *   "crm"  — 8X CRM sends them through its own Meta Conversions API
 *            integration. This app then reads and reports, and writes nothing.
 *
 * Set CAPI_SENDER=crm on Vercel only once the CRM's Conversion Logs actually
 * show events arriving. Until then the CRM sends nothing, and switching early
 * means nobody is sending at all.
 */
export type Sender = "app" | "crm";

export const SENDER: Sender = process.env.CAPI_SENDER === "crm" ? "crm" : "app";

/** True while this app is the one talking to Meta about lead stages. */
export const APP_SENDS_EVENTS = SENDER === "app";
