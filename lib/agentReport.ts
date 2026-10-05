/**
 * How well each agent works the leads handed to them.
 *
 * Built from what the agent app already records on every lead - when it was
 * handed over, when it was first called, how many calls, the stage, the
 * follow-up time - plus the stage notes (for "not qualified" reasons) and the
 * hand-offs (leads that left an agent because nobody called them).
 *
 * Test leads never count. A lead belongs to the agent who holds it now; one
 * that was moved away for not being called counts against the agent it left.
 */

import { supabaseAdmin } from "./supabase";
import { rankOf, STAGE_BY_STATUS, type Status } from "./stages";
import { AGENT_TEXT } from "./agentText";
import { medianOf } from "./agents";

type DB = ReturnType<typeof supabaseAdmin>;

type LeadRow = {
  lead_id: string;
  full_name: string | null;
  phone: string | null;
  status: Status;
  campaign_id: string | null;
  campaign_name: string | null;
  agent_id: string | null;
  assigned_at: string | null;
  first_call_at: string | null;
  last_call_at: string | null;
  call_count: number | null;
  follow_up_at: string | null;
  notes: string | null;
  tried_agent_ids: string[] | null;
};

export type CampaignSlice = {
  campaign_id: string | null;
  campaign_name: string;
  leads: number;
  called: number;
  median_call_min: number | null;
  answered: number;
  qualified: number;
};

export type ReportLead = {
  lead_id: string;
  name: string | null;
  phone: string | null;
  campaign: string | null;
  status: Status;
  assigned_at: string | null;
  first_call_min: number | null;
  calls: number;
  follow_up_at: string | null;
  follow_up_state: "none" | "upcoming" | "on_time" | "late" | "missed";
  note: string | null;
};

export type AgentReport = {
  agent_id: string;
  name: string;
  /** 0-100: speed 30, coverage 25, answered→qualified 20, callbacks 15, notes 10. */
  score: number | null;
  leads: number;
  worked: number;
  untouched: number;
  untouched_over_15m: number;
  called: number;
  calls: number;
  calls_per_lead: number | null;
  median_call_min: number | null;
  within5_pct: number | null;
  within15_pct: number | null;
  answered: number;
  answer_rate: number | null;
  no_answer: number;
  unreachable: number;
  qualified: number;
  qualified_rate: number | null;
  later_stages: number;
  reservations: number;
  disqualified: number;
  reasons: { reason: string; count: number }[];
  followups_due: number;
  followups_on_time: number;
  followups_late: number;
  followups_missed: number;
  followups_upcoming: number;
  noted: number;
  notes_rate: number | null;
  moved_away: number;
  by_status: Partial<Record<Status, number>>;
  by_campaign: CampaignSlice[];
  leads_list: ReportLead[];
};

const NOT_REACHED: Status[] = ["new", "no_answer", "unreachable"];
const KNOWN_REASONS = [...AGENT_TEXT.ar.reasons, ...AGENT_TEXT.en.reasons];
/** A callback counts as kept if called up to this long after its time. */
const ON_TIME_MS = 15 * 60_000;

const pct = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) : null);
const minutesBetween = (from: string | null, to: string | null) =>
  from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000)) : null;

function followUpState(l: LeadRow, now: number): ReportLead["follow_up_state"] {
  if (!l.follow_up_at) return "none";
  const at = Date.parse(l.follow_up_at);
  if (at > now) return "upcoming";
  const called = l.last_call_at ? Date.parse(l.last_call_at) : 0;
  if (called >= at - 5 * 60_000) return called <= at + ON_TIME_MS ? "on_time" : "late";
  return now - at > ON_TIME_MS ? "missed" : "upcoming";
}

/** The reasons an agent ticked, from "No budget, Broker — free text". */
function reasonsIn(body: string | null): string[] {
  if (!body) return [];
  const head = body.split(" — ")[0];
  return head
    .split(/[،,]/)
    .map((r) => r.trim())
    .filter((r) => KNOWN_REASONS.includes(r));
}

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 300) out.push(...(await fetch(ids.slice(i, i + 300))));
  return out;
}

export async function agentReports(
  db: DB,
  opts: { since: string; until: string; agentId?: string; withLeads?: boolean }
): Promise<AgentReport[]> {
  const now = Date.now();
  let agentsQ = db.from("agents").select("id,name").order("created_at", { ascending: true });
  if (opts.agentId) agentsQ = agentsQ.eq("id", opts.agentId);
  const { data: agentRows } = await agentsQ;
  const agents = (agentRows ?? []) as { id: string; name: string }[];
  if (agents.length === 0) return [];

  const cols =
    "lead_id,full_name,phone,status,campaign_id,campaign_name,agent_id,assigned_at,first_call_at,last_call_at,call_count,follow_up_at,notes,tried_agent_ids";
  const base = () =>
    db
      .from("leads")
      .select(cols)
      .eq("is_test", false)
      .gte("assigned_at", opts.since)
      .lte("assigned_at", opts.until)
      .order("assigned_at", { ascending: false })
      .limit(10000);
  // One agent: their own leads, plus the ones that left them for not being
  // called (now someone else's, or nobody's). Everyone: every assigned lead.
  const [heldRes, leftRes] = await Promise.all([
    opts.agentId ? base().eq("agent_id", opts.agentId) : base().not("agent_id", "is", null),
    opts.agentId ? base().contains("tried_agent_ids", [opts.agentId]) : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set<string>();
  const leads = ([...(heldRes.data ?? []), ...(leftRes.data ?? [])] as unknown as LeadRow[]).filter((l) =>
    seen.has(l.lead_id) ? false : (seen.add(l.lead_id), true)
  );

  // Notes and "not qualified" reasons, for the leads in range.
  const ids = leads.map((l) => l.lead_id);
  const notes = await inChunks(ids, async (chunk) => {
    const { data } = await db
      .from("lead_notes")
      .select("lead_id,kind,to_status,body,author")
      .in("lead_id", chunk)
      .in("kind", ["note", "stage"]);
    return (data ?? []) as { lead_id: string; kind: string; to_status: string | null; body: string | null; author: string | null }[];
  });
  const notedBy = new Map<string, Set<string>>(); // agent name -> lead ids with a written note
  const reasonsByLead = new Map<string, string[]>();
  for (const n of notes) {
    if (n.body && n.body.trim() && n.author) {
      const set = notedBy.get(n.author) ?? new Set<string>();
      set.add(n.lead_id);
      notedBy.set(n.author, set);
    }
    if (n.kind === "stage" && n.to_status === "disqualified") reasonsByLead.set(n.lead_id, reasonsIn(n.body));
  }

  return agents.map((agent) => {
    const mine = leads.filter((l) => l.agent_id === agent.id);
    const movedAway = leads.filter((l) => l.agent_id !== agent.id && (l.tried_agent_ids ?? []).includes(agent.id)).length;

    const waits = mine.map((l) => minutesBetween(l.assigned_at, l.first_call_at)).filter((w): w is number => w !== null);
    const called = mine.filter((l) => l.first_call_at);
    const worked = mine.filter((l) => l.first_call_at || l.status !== "new");
    const untouched = mine.filter((l) => !l.first_call_at && l.status === "new");
    const answered = mine.filter((l) => !NOT_REACHED.includes(l.status));
    const qualified = mine.filter((l) => rankOf(l.status) >= 2);
    const disqualified = mine.filter((l) => l.status === "disqualified");

    const reasonCount = new Map<string, number>();
    for (const l of disqualified) for (const r of reasonsByLead.get(l.lead_id) ?? []) reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);

    const fu = mine.map((l) => followUpState(l, now));
    const due = fu.filter((s) => s === "on_time" || s === "late" || s === "missed").length;
    const onTime = fu.filter((s) => s === "on_time").length;

    const noted = mine.filter((l) => notedBy.get(agent.name)?.has(l.lead_id) || (l.notes && l.notes.trim())).length;

    const byStatus: Partial<Record<Status, number>> = {};
    for (const l of mine) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;

    const campaigns = new Map<string, LeadRow[]>();
    for (const l of mine) {
      const k = l.campaign_id ?? "—";
      campaigns.set(k, [...(campaigns.get(k) ?? []), l]);
    }
    const byCampaign: CampaignSlice[] = [...campaigns.entries()]
      .map(([id, ls]) => ({
        campaign_id: id === "—" ? null : id,
        campaign_name: ls[0].campaign_name || id,
        leads: ls.length,
        called: ls.filter((l) => l.first_call_at).length,
        median_call_min: medianOf(ls.map((l) => minutesBetween(l.assigned_at, l.first_call_at)).filter((w): w is number => w !== null)),
        answered: ls.filter((l) => !NOT_REACHED.includes(l.status)).length,
        qualified: ls.filter((l) => rankOf(l.status) >= 2).length,
      }))
      .sort((a, b) => b.leads - a.leads);

    const within5 = waits.filter((w) => w <= 5).length;
    const within15 = waits.filter((w) => w <= 15).length;
    const total = mine.length;

    // The score: what a manager would look at first, weighted. Each part is
    // 0-1; a part with nothing to measure yet is left out rather than counted
    // as zero, so a new agent is not punished for having no callbacks yet.
    const parts: [number, number | null][] = [
      [30, waits.length ? within5 / waits.length * 0.7 + within15 / waits.length * 0.3 : null],
      [25, total ? worked.length / total : null],
      [20, answered.length ? qualified.length / answered.length : null],
      [15, due ? onTime / due : null],
      [10, worked.length ? Math.min(1, noted / worked.length) : null],
    ];
    const counted = parts.filter(([, v]) => v !== null) as [number, number][];
    const weight = counted.reduce((s, [w]) => s + w, 0);
    const score = weight ? Math.round((100 * counted.reduce((s, [w, v]) => s + w * v, 0)) / weight) : null;

    return {
      agent_id: agent.id,
      name: agent.name,
      score,
      leads: total,
      worked: worked.length,
      untouched: untouched.length,
      untouched_over_15m: untouched.filter((l) => l.assigned_at && now - Date.parse(l.assigned_at) > 15 * 60_000).length,
      called: called.length,
      calls: mine.reduce((s, l) => s + Number(l.call_count ?? 0), 0),
      calls_per_lead: called.length ? Math.round((10 * mine.reduce((s, l) => s + Number(l.call_count ?? 0), 0)) / called.length) / 10 : null,
      median_call_min: medianOf(waits),
      within5_pct: pct(within5, waits.length),
      within15_pct: pct(within15, waits.length),
      answered: answered.length,
      answer_rate: pct(answered.length, worked.length),
      no_answer: byStatus.no_answer ?? 0,
      unreachable: byStatus.unreachable ?? 0,
      qualified: qualified.length,
      qualified_rate: pct(qualified.length, answered.length),
      later_stages: mine.filter((l) => rankOf(l.status) >= 3).length,
      reservations: byStatus.reservation ?? 0,
      disqualified: disqualified.length,
      reasons: [...reasonCount.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      followups_due: due,
      followups_on_time: onTime,
      followups_late: fu.filter((s) => s === "late").length,
      followups_missed: fu.filter((s) => s === "missed").length,
      followups_upcoming: fu.filter((s) => s === "upcoming").length,
      noted,
      notes_rate: pct(noted, worked.length),
      moved_away: movedAway,
      by_status: byStatus,
      by_campaign: byCampaign,
      leads_list: opts.withLeads
        ? mine.map((l, i) => ({
            lead_id: l.lead_id,
            name: l.full_name,
            phone: l.phone,
            campaign: l.campaign_name,
            status: l.status,
            assigned_at: l.assigned_at,
            first_call_min: minutesBetween(l.assigned_at, l.first_call_at),
            calls: Number(l.call_count ?? 0),
            follow_up_at: l.follow_up_at,
            follow_up_state: fu[i],
            note: l.notes,
          }))
        : [],
    };
  });
}

export const stageLabel = (s: Status, ar: boolean) => (ar ? STAGE_BY_STATUS[s]?.labelAr : STAGE_BY_STATUS[s]?.label) ?? s;
