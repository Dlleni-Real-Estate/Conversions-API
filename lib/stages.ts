/**
 * The heart of the feedback loop: which CRM status maps to which Meta event.
 *
 * Meta already fires `Lead` the moment the instant form is submitted. Everything
 * below that is OUR signal — it tells Meta which of those form-fills were
 * actually worth money. Once ~200 leads/month flow through, switch the ad set's
 * performance goal to Conversion Leads and pick `Qualified` (or `Purchase`) as
 * the optimization event.
 */

export type Status =
  | "new"
  | "contacted"
  | "qualified"
  | "meeting"
  | "visited"
  | "won"
  | "junk"
  | "lost";

export type StageDef = {
  status: Status;
  label: string;          // Arabic label shown to brokers
  event: string | null;   // Meta event name — null = don't send
  color: string;          // tailwind classes for the badge
  /** A status the algorithm should learn to seek (true) or avoid (false). */
  positive: boolean | null;
};

export const STAGES: StageDef[] = [
  { status: "new",       label: "جديد",           event: null,           color: "bg-slate-100 text-slate-700 border-slate-200",     positive: null },
  { status: "contacted", label: "اتكلمنا معاه",   event: "Contacted",    color: "bg-sky-50 text-sky-700 border-sky-200",            positive: null },
  { status: "qualified", label: "مؤهّل",          event: "Qualified",    color: "bg-emerald-50 text-emerald-700 border-emerald-200", positive: true },
  { status: "meeting",   label: "حجز معاينة",     event: "Schedule",     color: "bg-violet-50 text-violet-700 border-violet-200",   positive: true },
  { status: "visited",   label: "عاين",           event: "Visited",      color: "bg-indigo-50 text-indigo-700 border-indigo-200",   positive: true },
  { status: "won",       label: "باع ✅",          event: "Purchase",     color: "bg-green-600 text-white border-green-700",         positive: true },
  { status: "junk",      label: "زبالة / رقم غلط", event: "Disqualified", color: "bg-red-50 text-red-700 border-red-200",            positive: false },
  { status: "lost",      label: "مش مهتم",        event: "Disqualified", color: "bg-amber-50 text-amber-800 border-amber-200",      positive: false },
];

export const STAGE_BY_STATUS: Record<Status, StageDef> = Object.fromEntries(
  STAGES.map((s) => [s.status, s])
) as Record<Status, StageDef>;

export const QUALIFIED_STATUSES: Status[] = ["qualified", "meeting", "visited", "won"];

export function isStatus(v: string): v is Status {
  return STAGES.some((s) => s.status === v);
}
