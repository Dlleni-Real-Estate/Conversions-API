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
  /** English label. */
  label: string;
  /** Arabic label — the same stage, written for the team that uses it. */
  labelAr: string;
  /** Meta event name — null means the change stays internal. */
  event: string | null;
  /**
   * Position in the funnel. Anything >= 1 is progress; -1 and below is off the
   * funnel. Progress is cumulative: a lead at rank 5 has passed rank 3.
   */
  rank: number;
  /** true = the algorithm should seek this, false = avoid, null = neutral. */
  positive: boolean | null;
  /** Badge styling — background, text and border together. */
  color: string;
  /** Very light tint, for the surface of a card in this stage. */
  soft: string;
  /** Accent used by bars, dots and the edge stripe on a row. */
  accent: string;
  hint?: string;
  hintAr?: string;
};

export const STAGES: StageDef[] = [
  {
    status: "new",
    label: "New",
    labelAr: "جديد",
    event: null,
    rank: 0,
    positive: null,
    color: "bg-slate-100 text-slate-600 border-slate-300",
    soft: "bg-slate-50",
    accent: "#94a3b8",
    hint: "Nobody has touched this lead yet",
    hintAr: "لسه محدش مسكه",
  },
  {
    status: "contacted",
    label: "Contacted",
    labelAr: "اتكلمنا معاه",
    event: "Contacted",
    rank: 1,
    positive: null,
    color: "bg-sky-50 text-sky-800 border-sky-300",
    soft: "bg-sky-50/60",
    accent: "#0284c7",
    hint: "Reached them on the phone",
    hintAr: "كلّمناه على التليفون",
  },
  {
    status: "no_answer",
    label: "No answer",
    labelAr: "مردّش",
    event: "NoAnswer",
    rank: -1,
    positive: false,
    color: "bg-orange-50 text-orange-800 border-orange-300",
    soft: "bg-orange-50/60",
    accent: "#f97316",
    hint: "Called, nobody picked up",
    hintAr: "اتصلنا وما ردّش",
  },
  {
    status: "qualified",
    label: "Qualified",
    labelAr: "مؤهّل",
    event: "Qualified",
    rank: 2,
    positive: true,
    color: "bg-violet-50 text-violet-800 border-violet-300",
    soft: "bg-violet-50/60",
    accent: "#7c3aed",
    hint: "Real budget, real intent",
    hintAr: "عنده ميزانية ونيّة شراء",
  },
  {
    status: "meeting_booked",
    label: "Meeting booked",
    labelAr: "حجز اجتماع",
    event: "MeetingBooked",
    rank: 3,
    positive: true,
    color: "bg-fuchsia-50 text-fuchsia-800 border-fuchsia-300",
    soft: "bg-fuchsia-50/60",
    accent: "#d946ef",
  },
  {
    status: "meeting_done",
    label: "Meeting done",
    labelAr: "تم الاجتماع",
    event: "MeetingDone",
    rank: 4,
    positive: true,
    color: "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-400",
    soft: "bg-fuchsia-50",
    accent: "#a21caf",
  },
  {
    status: "site_visit_booked",
    label: "Site visit booked",
    labelAr: "حجز معاينة",
    event: "SiteVisitBooked",
    rank: 5,
    positive: true,
    color: "bg-cyan-50 text-cyan-800 border-cyan-300",
    soft: "bg-cyan-50/60",
    accent: "#06b6d4",
  },
  {
    status: "site_visit_done",
    label: "Site visit done",
    labelAr: "تمت المعاينة",
    event: "SiteVisitDone",
    rank: 6,
    positive: true,
    color: "bg-cyan-100 text-cyan-900 border-cyan-400",
    soft: "bg-cyan-50",
    accent: "#0e7490",
  },
  {
    status: "eoi",
    label: "EOI",
    labelAr: "وقّع EOI",
    event: "EOI",
    rank: 7,
    positive: true,
    color: "bg-amber-100 text-amber-900 border-amber-400",
    soft: "bg-amber-50",
    accent: "#b45309",
    hint: "Expression of interest signed",
    hintAr: "وقّع خطاب إبداء الرغبة",
  },
  {
    status: "reservation",
    label: "Reservation",
    labelAr: "عمل ريزيرفيشن",
    event: "Reservation",
    rank: 8,
    positive: true,
    color: "bg-emerald-600 text-white border-emerald-700",
    soft: "bg-emerald-50",
    accent: "#059669",
    hint: "Money down — the outcome everything else is trying to predict",
    hintAr: "دفع — ده الهدف اللي كل حاجة تانية بتحاول تتنبأ بيه",
  },
  {
    status: "disqualified",
    label: "Disqualified",
    labelAr: "مستبعد",
    event: "Disqualified",
    rank: -2,
    positive: false,
    color: "bg-red-50 text-red-800 border-red-300",
    soft: "bg-red-50/60",
    accent: "#dc2626",
    hint: "Wrong number, no budget, not interested",
    hintAr: "رقم غلط، مفيش ميزانية، مش مهتم",
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

/**
 * The moves a broker reaches for most, in order. On a phone these become big
 * buttons instead of a dropdown, because a 10-item select on a touch screen is
 * where speed goes to die.
 */
export const QUICK_MOVES: Status[] = ["contacted", "no_answer", "qualified", "disqualified"];

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
