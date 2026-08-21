/**
 * The sales pipeline, and which Meta event each stage sends back.
 *
 * Meta already fires `Lead` when the instant form is submitted. Everything
 * below is OUR signal: it tells Meta which of those form-fills turned into a
 * person who actually showed up and paid. The event NAME is ours to choose —
 * whatever string we send becomes a selectable conversion event in Ads Manager.
 *
 * "Booked" and "done" are deliberately separate stages. The gap between them is
 * the no-show rate, and no-show rate per creative is one of the most honest
 * quality signals a real-estate team has.
 */

export type Status =
  | "new"
  | "contacted"
  | "no_answer"
  | "qualified"
  | "meeting_booked"
  | "meeting_done"
  | "site_visit_booked"
  | "site_visit_done"
  | "eoi"
  | "reservation"
  | "disqualified";

export type StageDef = {
  status: Status;
  label: string;
  /** Meta event name — null means the change stays internal. */
  event: string | null;
  /**
   * Position in the funnel. Anything >= 1 is progress; -1 and below is off the
   * funnel. Progress is cumulative: a lead at rank 5 has passed rank 3.
   */
  rank: number;
  /** true = the algorithm should seek this, false = avoid, null = neutral. */
  positive: boolean | null;
  /** Badge styling. */
  color: string;
  /** Accent used by the funnel and charts. */
  accent: string;
  hint?: string;
};

export const STAGES: StageDef[] = [
  {
    status: "new",
    label: "New",
    event: null,
    rank: 0,
    positive: null,
    color: "bg-slate-100 text-slate-600 border-slate-200",
    accent: "#94a3b8",
    hint: "Nobody has touched this lead yet",
  },
  {
    status: "contacted",
    label: "Contacted",
    event: "Contacted",
    rank: 1,
    positive: null,
    color: "bg-sky-50 text-sky-700 border-sky-200",
    accent: "#0ea5e9",
    hint: "Reached them on the phone",
  },
  {
    status: "no_answer",
    label: "No answer",
    event: "NoAnswer",
    rank: -1,
    positive: false,
    color: "bg-amber-50 text-amber-800 border-amber-200",
    accent: "#f59e0b",
    hint: "Called, nobody picked up",
  },
  {
    status: "qualified",
    label: "Qualified",
    event: "Qualified",
    rank: 2,
    positive: true,
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
    accent: "#10b981",
    hint: "Real budget, real intent",
  },
  {
    status: "meeting_booked",
    label: "Meeting booked",
    event: "MeetingBooked",
    rank: 3,
    positive: true,
    color: "bg-violet-50 text-violet-700 border-violet-200",
    accent: "#8b5cf6",
  },
  {
    status: "meeting_done",
    label: "Meeting done",
    event: "MeetingDone",
    rank: 4,
    positive: true,
    color: "bg-violet-100 text-violet-800 border-violet-300",
    accent: "#7c3aed",
  },
  {
    status: "site_visit_booked",
    label: "Site visit booked",
    event: "SiteVisitBooked",
    rank: 5,
    positive: true,
    color: "bg-indigo-50 text-indigo-700 border-indigo-200",
    accent: "#6366f1",
  },
  {
    status: "site_visit_done",
    label: "Site visit done",
    event: "SiteVisitDone",
    rank: 6,
    positive: true,
    color: "bg-indigo-100 text-indigo-800 border-indigo-300",
    accent: "#4f46e5",
  },
  {
    status: "eoi",
    label: "EOI",
    event: "EOI",
    rank: 7,
    positive: true,
    color: "bg-teal-100 text-teal-800 border-teal-300",
    accent: "#0d9488",
    hint: "Expression of interest signed",
  },
  {
    status: "reservation",
    label: "Reservation",
    event: "Reservation",
    rank: 8,
    positive: true,
    color: "bg-green-600 text-white border-green-700",
    accent: "#16a34a",
    hint: "Money down — the outcome everything else is trying to predict",
  },
  {
    status: "disqualified",
    label: "Disqualified",
    event: "Disqualified",
    rank: -2,
    positive: false,
    color: "bg-red-50 text-red-700 border-red-200",
    accent: "#ef4444",
    hint: "Wrong number, no budget, not interested",
  },
];

export const STAGE_BY_STATUS: Record<Status, StageDef> = Object.fromEntries(
  STAGES.map((s) => [s.status, s])
) as Record<Status, StageDef>;

/** Funnel order for charts and conversion rates — progress stages only. */
export const FUNNEL: Status[] = [
  "contacted",
  "qualified",
  "meeting_booked",
  "meeting_done",
  "site_visit_booked",
  "site_visit_done",
  "eoi",
  "reservation",
];

/** Stages a broker can move a lead into (everything except the initial state). */
export const ACTIONABLE: Status[] = STAGES.filter((s) => s.status !== "new").map((s) => s.status);

export const QUALIFIED_STATUSES: Status[] = STAGES.filter((s) => s.rank >= 2).map((s) => s.status);

export function rankOf(status: Status): number {
  return STAGE_BY_STATUS[status]?.rank ?? 0;
}

/** Has this lead reached `stage` — now, or by passing through it earlier? */
export function hasReached(status: Status, stage: Status): boolean {
  const r = rankOf(status);
  return r > 0 && r >= rankOf(stage);
}

export function isStatus(v: string): v is Status {
  return STAGES.some((s) => s.status === v);
}
