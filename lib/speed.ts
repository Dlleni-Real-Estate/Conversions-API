/**
 * Speed to lead, and whose speed it was.
 *
 * THE QUESTION
 * ────────────
 * "How long did this lead wait before anyone did anything with it?" is one
 * number for the customer and two numbers for the team:
 *
 *   routing  lead lands in 8X  ->  team leader hands it to an agent
 *   pickup   agent receives it  ->  that agent's first action on it
 *
 * Splitting it is the whole point. An agent handed a lead at 5pm that arrived
 * at noon did not make it wait five hours; the hand-off did. And a team leader
 * who picks up the phone herself before routing gets the credit for that call.
 *
 * WORKING TIME
 * ────────────
 * Every duration is counted in WORKING minutes: 12:00 to 21:00 Cairo time,
 * every day, no weekly day off (the team's own hours). A lead that arrives at
 * 2am and is called at 12:10 waited ten minutes, not ten hours. Raw clock time
 * would bury every agent under the night shift nobody works.
 *
 * WHERE THE TIMES COME FROM
 * ─────────────────────────
 *  - arrival: 8X's own created_at for the lead (falls back to our push time,
 *    then to the Meta submit time for leads mirrored before that was stored)
 *  - hand-off: the assignee entry's created_at - when the agent was given it
 *  - actions: 8X's last_activity (real author, real time), plus stage moves.
 *    Stage moves recorded before the activity log existed carry the time the
 *    sync noticed them; those leads are flagged `approx`.
 */

export const WORK_TZ = "Africa/Cairo";
export const WORK_START_HOUR = 12;
export const WORK_END_HOUR = 21;
export const WORK_DAY_MIN = (WORK_END_HOUR - WORK_START_HOUR) * 60;

/**
 * Who routes. A lead that sits with one of these people first and then goes to
 * someone else was ROUTED by them, and the gap is theirs. Names, not ids,
 * because every stored row carries the resolved name (lib/crm.ts).
 */
export const TEAM_LEADERS = new Set(["Youstina Tadros", "Shama Abdelhamid", "General Manager"]);

/**
 * A lead given straight to an agent within this many real minutes of landing
 * was routed by 8X's own rules, not by a person - nobody's routing time.
 */
const AUTO_ROUTE_GRACE_MIN = 2;

/** Names an older sync stored before the user id was known. */
const NAME_ALIASES: Record<string, string> = { "Agent #14": "Hanaa Sayd" };
export const canonicalName = (n: string) => NAME_ALIASES[n] ?? n;

// ─────────────────────────────────────────────────────────────────────────────
// Working-time arithmetic
// ─────────────────────────────────────────────────────────────────────────────

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: WORK_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Cairo's offset from UTC at an instant, in ms. Egypt observes DST, so this moves. */
function tzOffsetMs(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant (UTC ms) of hour `h` on Cairo calendar day y-m-d. */
function cairoAt(y: number, m: number, d: number, h: number): number {
  const guess = Date.UTC(y, m, d, h);
  const off1 = tzOffsetMs(guess);
  const off2 = tzOffsetMs(guess - off1);
  return guess - off2;
}

/** Working minutes between two instants. 0 when `to` is not after `from`. */
export function workMinutes(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  const local = new Date(fromMs + tzOffsetMs(fromMs));
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  let d = local.getUTCDate();
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const open = cairoAt(y, m, d, WORK_START_HOUR);
    if (open >= toMs) break;
    const close = cairoAt(y, m, d, WORK_END_HOUR);
    const a = Math.max(open, fromMs);
    const b = Math.min(close, toMs);
    if (b > a) total += b - a;
    const next = new Date(Date.UTC(y, m, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth();
    d = next.getUTCDate();
  }
  return Math.round(total / 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// One lead
// ─────────────────────────────────────────────────────────────────────────────

export type SpeedLeadInput = {
  lead_id: string;
  full_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  status: string;
  quality_score: number | null;
  owner: string | null;
  submitted_at: string;
  crm_created_at: string | null;
  crm_pushed_at: string | null;
};

export type AssignmentRow = { lead_id: string; user_name: string | null; user_id: number; assigned_at: string };
export type ActivityRow = {
  lead_id: string;
  kind: "activity" | "stage";
  at: string;
  actor: string;
  approx: boolean;
  to_status: string | null;
};

export type Phase = "not_in_crm" | "awaiting_route" | "awaiting_agent" | "contacted";

export type LeadSpeed = {
  lead_id: string;
  full_name: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  status: string;
  quality_score: number | null;
  arrived_at: string;
  /** Team leader who held the lead before it went to an agent. */
  router: string | null;
  /** First agent it was handed to. */
  routed_to: string | null;
  routed_at: string | null;
  /** Working minutes from arrival to hand-off. 0 when 8X routed it by rule. */
  route_min: number | null;
  auto_routed: boolean;
  /** The person answerable for first contact, and since when. */
  handler: string | null;
  handler_since: string | null;
  handler_first_at: string | null;
  /** Working minutes from handler_since to the handler's own first action. */
  pickup_min: number | null;
  /** First action on the lead by anyone. */
  first_action_at: string | null;
  first_action_by: string | null;
  /** Working minutes from arrival to that first action - the customer's wait. */
  total_min: number | null;
  /** Still untouched: working minutes waited so far on the current clock. */
  wait_min: number | null;
  phase: Phase;
  /** A team leader acted on it herself before handing it on. */
  self_handled: boolean;
  handler_actions: number;
  approx: boolean;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const iso = (t: number | null | undefined) => (t != null && Number.isFinite(t) ? new Date(t).toISOString() : null);

export function deriveLead(
  lead: SpeedLeadInput,
  assignmentsIn: AssignmentRow[],
  activitiesIn: ActivityRow[],
  now = Date.now()
): LeadSpeed {
  const arrived =
    [ms(lead.crm_created_at), ms(lead.crm_pushed_at), ms(lead.submitted_at)].find((t) => Number.isFinite(t)) ?? now;

  // Earliest time each person was given the lead.
  const firstBy = new Map<string, number>();
  for (const a of assignmentsIn) {
    const name = canonicalName(a.user_name || `Agent #${a.user_id}`);
    const t = ms(a.assigned_at);
    if (!Number.isFinite(t)) continue;
    const cur = firstBy.get(name);
    if (cur === undefined || t < cur) firstBy.set(name, t);
  }
  let assignments = [...firstBy.entries()].map(([user, at]) => ({ user, at })).sort((a, b) => a.at - b.at);

  // Before the first sync with the assignment log, all we know is who holds it
  // now. Enough to say whose lead it is; not enough to time a hand-off.
  let approx = false;
  if (assignments.length === 0 && lead.owner) {
    assignments = lead.owner
      .split(" + ")
      .map((n) => canonicalName(n.trim()))
      .filter(Boolean)
      .map((user) => ({ user, at: NaN }));
    approx = true;
  }
  const inCrm = assignments.length > 0;

  const leaders = assignments.filter((a) => TEAM_LEADERS.has(a.user));
  const agents = assignments.filter((a) => !TEAM_LEADERS.has(a.user));

  const firstAgent = agents.find((a) => Number.isFinite(a.at)) ?? null;
  const routedAt = firstAgent ? firstAgent.at : null;
  const leaderBefore = routedAt !== null ? leaders.find((l) => !Number.isFinite(l.at) || l.at <= routedAt + 60_000) : leaders[0];
  const autoRouted =
    routedAt !== null && !leaderBefore && (routedAt - arrived) / 60000 <= AUTO_ROUTE_GRACE_MIN;
  const router = routedAt !== null ? (autoRouted ? null : leaderBefore?.user ?? null) : null;
  const routeMin = routedAt !== null ? (autoRouted ? 0 : workMinutes(arrived, routedAt)) : null;

  // Who held the lead at a given moment - for actions whose author 8X did not
  // name (stage moves). After the hand-off it is the agent who had it by then;
  // before, the leader holding it.
  const holderAt = (t: number): string | null => {
    if (routedAt !== null && t >= routedAt) {
      const held = agents.filter((a) => Number.isFinite(a.at) && a.at <= t);
      return (held[held.length - 1] ?? firstAgent)?.user ?? null;
    }
    return (leaderBefore ?? leaders[0] ?? agents[0])?.user ?? null;
  };

  const actions = activitiesIn
    .map((a) => {
      const t = ms(a.at);
      const who = a.actor ? canonicalName(a.actor) : holderAt(t);
      return { t, who, approx: a.approx };
    })
    .filter((a) => Number.isFinite(a.t) && a.t >= arrived - 10 * 60_000)
    .sort((a, b) => a.t - b.t);

  const first = actions[0] ?? null;
  if (first?.approx) approx = true;

  // The handler: the agent who actually worked it first, else the agent who
  // holds it now. With no agent at all, the leader holding it is the handler.
  let handler: string | null = null;
  let handlerSince: number | null = null;
  if (agents.length > 0) {
    const worked = agents.find((a) => actions.some((x) => x.who === a.user));
    const pick = worked ?? agents[agents.length - 1];
    handler = pick.user;
    handlerSince = Number.isFinite(pick.at) ? pick.at : arrived;
  } else if (assignments.length > 0) {
    handler = (leaders[0] ?? assignments[0]).user;
    handlerSince = arrived;
  }

  const handlerActs = handler ? actions.filter((x) => x.who === handler && x.t >= (handlerSince ?? arrived) - 60_000) : [];
  const handlerFirst = handlerActs[0]?.t ?? null;
  const pickupMin = handlerFirst !== null && handlerSince !== null ? workMinutes(handlerSince, handlerFirst) : null;

  const selfHandled =
    !!first && !!first.who && TEAM_LEADERS.has(first.who) && (routedAt === null || first.t < routedAt);

  let phase: Phase;
  let waitMin: number | null = null;
  if (!inCrm) phase = "not_in_crm";
  else if (first) phase = "contacted";
  else {
    phase = routedAt === null && handler && TEAM_LEADERS.has(handler) ? "awaiting_route" : "awaiting_agent";
    waitMin = workMinutes(phase === "awaiting_agent" && routedAt !== null ? routedAt : arrived, now);
  }

  return {
    lead_id: lead.lead_id,
    full_name: lead.full_name,
    campaign_name: lead.campaign_name,
    adset_name: lead.adset_name,
    status: lead.status,
    quality_score: lead.quality_score,
    arrived_at: iso(arrived)!,
    router,
    routed_to: firstAgent?.user ?? null,
    routed_at: iso(routedAt),
    route_min: routeMin,
    auto_routed: autoRouted,
    handler,
    handler_since: iso(handlerSince),
    handler_first_at: iso(handlerFirst),
    pickup_min: pickupMin,
    first_action_at: iso(first?.t),
    first_action_by: first?.who ?? null,
    total_min: first ? workMinutes(arrived, first.t) : null,
    wait_min: waitMin,
    phase,
    self_handled: selfHandled,
    handler_actions: handlerActs.length,
    approx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One person
// ─────────────────────────────────────────────────────────────────────────────

export type TimeStats = {
  n: number;
  median: number | null;
  /** Share answered within 15 working minutes, 1 working hour, 1 working day. */
  within15: number | null;
  within60: number | null;
  withinDay: number | null;
};

export type PersonStats = {
  name: string;
  is_leader: boolean;
  // As the one answerable for first contact
  leads: number;
  picked_up: number;
  not_picked_up: number;
  oldest_wait_min: number | null;
  pickup: TimeStats;
  avg_actions: number | null;
  followed_up: number;
  no_answer: number;
  qualified: number;
  meetings: number;
  disqualified: number;
  avg_quality: number | null;
  // As router (team leaders)
  routed: number;
  routing: TimeStats;
  awaiting_route: number;
  oldest_route_wait_min: number | null;
  self_handled: number;
  self_contact: TimeStats;
};

export type TeamSummary = {
  leads: number;
  in_crm: number;
  contacted: number;
  untouched: number;
  auto_routed: number;
  total: TimeStats;
  routing: TimeStats;
  pickup: TimeStats;
  approx_leads: number;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

export function timeStats(values: number[]): TimeStats {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, median: null, within15: null, within60: null, withinDay: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  return {
    n: v.length,
    median,
    within15: pct(v.filter((x) => x <= 15).length, v.length),
    within60: pct(v.filter((x) => x <= 60).length, v.length),
    withinDay: pct(v.filter((x) => x <= WORK_DAY_MIN).length, v.length),
  };
}

/** Stage ranks, mirrored from lib/stages.ts so this file stays dependency-free. */
const RANK: Record<string, number> = {
  new: 0, contacted: 1, no_answer: -1, qualified: 2, meeting_booked: 3, meeting_done: 4,
  site_visit_booked: 5, site_visit_done: 6, eoi: 7, reservation: 8, disqualified: -2,
};

export function summarise(rows: LeadSpeed[]): { team: TeamSummary; people: PersonStats[] } {
  const inCrm = rows.filter((r) => r.phase !== "not_in_crm");
  const team: TeamSummary = {
    leads: rows.length,
    in_crm: inCrm.length,
    contacted: inCrm.filter((r) => r.phase === "contacted").length,
    untouched: inCrm.filter((r) => r.phase !== "contacted").length,
    auto_routed: inCrm.filter((r) => r.auto_routed).length,
    total: timeStats(inCrm.map((r) => r.total_min ?? NaN)),
    routing: timeStats(inCrm.filter((r) => r.router).map((r) => r.route_min ?? NaN)),
    pickup: timeStats(inCrm.map((r) => r.pickup_min ?? NaN)),
    approx_leads: inCrm.filter((r) => r.approx).length,
  };

  const names = new Set<string>();
  for (const r of inCrm) {
    if (r.handler) names.add(r.handler);
    if (r.router) names.add(r.router);
  }

  const people: PersonStats[] = [...names].map((name) => {
    const mine = inCrm.filter((r) => r.handler === name);
    const picked = mine.filter((r) => r.handler_first_at);
    const waiting = mine.filter((r) => !r.handler_first_at);
    const waits = waiting
      .map((r) => r.wait_min ?? (r.handler_since ? workMinutes(Date.parse(r.handler_since), Date.now()) : NaN))
      .filter((x) => Number.isFinite(x));
    const q = mine.map((r) => r.quality_score).filter((x): x is number => typeof x === "number");

    const routedByMe = inCrm.filter((r) => r.router === name && r.routed_at);
    const holdingUnrouted = inCrm.filter((r) => r.phase === "awaiting_route" && r.handler === name);
    const self = inCrm.filter((r) => r.self_handled && r.first_action_by === name);

    return {
      name,
      is_leader: TEAM_LEADERS.has(name),
      leads: mine.length,
      picked_up: picked.length,
      not_picked_up: waiting.length,
      oldest_wait_min: waits.length ? Math.max(...waits) : null,
      pickup: timeStats(picked.map((r) => r.pickup_min ?? NaN)),
      avg_actions: mine.length ? Math.round((10 * mine.reduce((s, r) => s + r.handler_actions, 0)) / mine.length) / 10 : null,
      followed_up: mine.filter((r) => r.handler_actions >= 2).length,
      no_answer: mine.filter((r) => RANK[r.status] === -1).length,
      qualified: mine.filter((r) => (RANK[r.status] ?? 0) >= 2).length,
      meetings: mine.filter((r) => (RANK[r.status] ?? 0) >= 3).length,
      disqualified: mine.filter((r) => RANK[r.status] === -2).length,
      avg_quality: q.length ? Math.round(q.reduce((s, x) => s + x, 0) / q.length) : null,
      routed: routedByMe.length,
      routing: timeStats(routedByMe.map((r) => r.route_min ?? NaN)),
      awaiting_route: holdingUnrouted.length,
      oldest_route_wait_min: holdingUnrouted.length
        ? Math.max(...holdingUnrouted.map((r) => r.wait_min ?? 0))
        : null,
      self_handled: self.length,
      self_contact: timeStats(self.map((r) => r.total_min ?? NaN)),
    };
  });

  // Leaders first, then agents by how fast they pick up; nobody with no
  // measured pickups is ranked above someone who has one.
  people.sort((a, b) => {
    if (a.is_leader !== b.is_leader) return a.is_leader ? -1 : 1;
    const am = a.pickup.median ?? Infinity;
    const bm = b.pickup.median ?? Infinity;
    return am - bm || b.leads - a.leads;
  });

  return { team, people };
}
