"use client";

import { useEffect, useMemo, useState } from "react";
import { STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { TEAM_LEADERS, type LeadSpeed, type PersonStats, type TeamSummary, type TimeStats } from "@/lib/speed";
import { Badge, Card, Empty, MetricGrid, SectionTitle, Stat, Td, Th, fmtDate, fmtInt, fmtPct } from "./ui";
import { useLang } from "./LangProvider";

export type TeamData = {
  ok: boolean;
  days: number;
  tracking_since: string | null;
  team: TeamSummary;
  people: PersonStats[];
  leads: LeadSpeed[];
};

/** Working minutes, written the way a person says them: 12m, 3h 20m. */
export function fmtWork(min: number | null | undefined, lang: "en" | "ar"): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "—";
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (lang === "ar") {
    if (h === 0) return `${m} د`;
    return r ? `${h} س ${r} د` : `${h} س`;
  }
  if (h === 0) return `${m}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** A median, with "~" in front when it is built from estimated leads only. */
function fmtStat(s: TimeStats, lang: "en" | "ar"): string {
  if (s.median === null) return "—";
  return `${s.est ? "~" : ""}${fmtWork(s.median, lang)}`;
}

/** Green under 15 working minutes, amber under an hour, red beyond. */
function speedTone(min: number | null | undefined, est = false): "good" | "default" | "bad" | "muted" {
  if (min === null || min === undefined || est) return "muted";
  if (min <= 15) return "good";
  if (min <= 60) return "default";
  return "bad";
}

const toneText = {
  good: "text-emerald-700",
  default: "text-amber-700",
  bad: "text-red-600",
  muted: "text-slate-500",
} as const;

type LeadFilter = "all" | "waiting" | "returning";

export default function TeamView({
  data,
  loading,
  days,
  onDays,
}: {
  data: TeamData | null;
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
}) {
  const { t, lang, locale } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);
  const [filter, setFilter] = useState<LeadFilter>("all");

  const leaders = useMemo(() => (data?.people ?? []).filter((p) => p.is_leader), [data]);
  const agents = useMemo(() => (data?.people ?? []).filter((p) => !p.is_leader), [data]);
  const person = open ? data?.people.find((p) => p.name === open) ?? null : null;

  const leadRows = useMemo(() => {
    const all = [...(data?.leads ?? [])].sort((a, b) => Date.parse(b.arrived_at) - Date.parse(a.arrived_at));
    if (filter === "waiting") return all.filter((l) => l.phase === "awaiting_route" || l.phase === "awaiting_agent");
    if (filter === "returning") return all.filter((l) => l.returning_since);
    return all;
  }, [data, filter]);

  const periodPicker = (
    <select
      value={days}
      onChange={(e) => onDays(Number(e.target.value))}
      className="tap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs shadow-card"
      aria-label={t.tmPeriod}
    >
      <option value={7}>{t.tmDays7}</option>
      <option value={30}>{t.tmDays30}</option>
      <option value={90}>{t.tmDays90}</option>
    </select>
  );

  if (!data) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-5 py-14 text-center text-sm text-slate-400">
        {loading ? t.loading : t.noData}
      </div>
    );
  }

  const { team } = data;
  const pctOf = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
  const waitingCount = data.leads.filter((l) => l.phase === "awaiting_route" || l.phase === "awaiting_agent").length;
  const estNote = (s: TimeStats) => (s.est ? ` · ${t.tmEstMedian}` : "");

  return (
    <div className="space-y-6">
      <div>
        <SectionTitle title={t.tmTitle} subtitle={t.tmSub} accent="#059669" right={<span className="ms-auto">{periodPicker}</span>} />

        <MetricGrid
          core={
            <>
              <Stat
                label={t.tmTotal}
                value={fmtStat(team.total, lang)}
                sub={t.tmTotalSub + estNote(team.total)}
                tone={speedTone(team.total.median, team.total.est)}
                accent="#0f172a"
              />
              <Stat
                label={t.tmRouting}
                value={fmtStat(team.routing, lang)}
                sub={t.tmRoutingSub + estNote(team.routing)}
                tone={speedTone(team.routing.median, team.routing.est)}
                accent="#7c3aed"
              />
              <Stat
                label={t.tmPickup}
                value={fmtStat(team.pickup, lang)}
                sub={t.tmPickupSub + estNote(team.pickup)}
                tone={speedTone(team.pickup.median, team.pickup.est)}
                accent="#059669"
              />
              <Stat
                label={t.tmUntouched}
                value={fmtInt(team.untouched)}
                sub={`${t.tmUntouchedSub} · ${t.tmOf} ${fmtInt(team.in_crm)}`}
                tone={team.untouched > 0 ? "bad" : "good"}
                accent="#f97316"
              />
            </>
          }
          more={
            <>
              <Stat label={t.tmWithin15} value={fmtPct(team.total.within15)} sub={t.tmTotal} />
              <Stat label={t.tmWithin60} value={fmtPct(team.total.within60)} sub={t.tmTotal} />
              <Stat label={t.tmWithinDay} value={fmtPct(team.total.withinDay)} sub={t.tmTotal} />
              <Stat
                label={t.tmContacted}
                value={fmtInt(team.contacted)}
                sub={`${fmtPct(pctOf(team.contacted, team.in_crm))} ${t.tmOf} ${fmtInt(team.in_crm)}`}
              />
              <Stat
                label={t.tmAuto}
                value={fmtInt(team.auto_routed)}
                sub={`${fmtPct(pctOf(team.auto_routed, team.in_crm))}`}
                tone="muted"
              />
              <Stat
                label={t.tmReturning}
                value={fmtInt(team.returning)}
                sub={`${fmtInt(team.returning_untouched)} ${t.tmReturningUntouchedSub}`}
                tone={team.returning_untouched > 0 ? "bad" : "muted"}
              />
            </>
          }
          moreLabel={t.showAllMetrics}
          lessLabel={t.showFewer}
        />

        {team.returning_untouched > 0 && (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span className="font-semibold">
              {fmtInt(team.returning_untouched)} {t.tmReturningAlertTitle}
            </span>{" "}
            {t.tmReturningAlert}{" "}
            <button onClick={() => setFilter("returning")} className="font-medium underline">
              {t.tmShowThem}
            </button>
          </div>
        )}

        <div className="mt-3 space-y-1.5 text-xs text-slate-500">
          <p>
            {data.tracking_since
              ? `${t.tmTrackingSince} ${fmtDate(data.tracking_since, locale)}`
              : t.tmTrackingNone}
            {team.approx_leads > 0 && (
              <>
                {" · "}
                <span className="text-amber-700">
                  {fmtInt(team.approx_leads)} {t.tmApprox}
                </span>
              </>
            )}
          </p>
          <button onClick={() => setShowHow((v) => !v)} className="font-medium text-brand-700 hover:underline">
            {t.tmHowTitle} {showHow ? "▴" : "▾"}
          </button>
          {showHow && (
            <ul className="list-disc space-y-1 ps-5 text-slate-600">
              <li>{t.tmHow1}</li>
              <li>{t.tmHow2}</li>
              <li>{t.tmHow3}</li>
              <li>{t.tmHow4}</li>
              <li>{t.tmHow5}</li>
              <li>{t.tmHow6}</li>
            </ul>
          )}
        </div>
      </div>

      {data.leads.length === 0 ? (
        <Card>
          <Empty>{t.tmNoData}</Empty>
        </Card>
      ) : (
        <>
          {leaders.length > 0 && (
            <div>
              <SectionTitle title={t.tmLeadersTitle} subtitle={t.tmLeadersSub} accent="#7c3aed" />
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {leaders.map((p) => (
                  <LeaderCard key={p.name} p={p} onOpen={() => setOpen(p.name)} />
                ))}
              </div>
            </div>
          )}

          <div>
            <SectionTitle title={t.tmAgentsTitle} subtitle={t.tmAgentsSub} accent="#059669" />
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-100">
                  <tr>
                    <Th>{t.tmColAgent}</Th>
                    <Th align="right">{t.tmColLeads}</Th>
                    <Th align="right">{t.tmColMedian}</Th>
                    <Th align="right">{t.tmColW15}</Th>
                    <Th align="right">{t.tmColW60}</Th>
                    <Th align="right">{t.tmColWaiting}</Th>
                    <Th align="right">{t.tmColOldest}</Th>
                    <Th align="right">{t.tmColFollow}</Th>
                    <Th align="right">{t.tmColQual}</Th>
                    <Th align="right">{t.tmColMeet}</Th>
                    <Th align="right">{t.tmColDisq}</Th>
                    <Th align="right">{t.tmColQuality}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {agents.map((p) => (
                    <tr key={p.name} className="hover:bg-slate-50">
                      <Td>
                        <button
                          onClick={() => setOpen(p.name)}
                          className="whitespace-nowrap font-medium text-brand-700 hover:underline"
                          dir="auto"
                        >
                          {p.name}
                        </button>
                      </Td>
                      <Td align="right">{fmtInt(p.leads)}</Td>
                      <Td
                        align="right"
                        className={`font-semibold ${toneText[speedTone(p.pickup.median, p.pickup.est)]}`}
                      >
                        <span title={p.pickup.est ? t.tmEstMedian : undefined}>{fmtStat(p.pickup, lang)}</span>
                        <span className="ms-1 text-[11px] font-normal text-slate-400">({fmtInt(p.pickup.n)})</span>
                      </Td>
                      <Td align="right">{fmtPct(p.pickup.within15)}</Td>
                      <Td align="right">{fmtPct(p.pickup.within60)}</Td>
                      <Td align="right" className={p.not_picked_up > 0 ? "font-semibold text-red-600" : "text-slate-400"}>
                        {fmtInt(p.not_picked_up)}
                      </Td>
                      <Td align="right" className={p.oldest_wait_min ? "text-red-600" : "text-slate-400"}>
                        {fmtWork(p.oldest_wait_min, lang)}
                      </Td>
                      <Td align="right">{p.avg_actions ?? "—"}</Td>
                      <Td align="right">{fmtInt(p.qualified)}</Td>
                      <Td align="right">{fmtInt(p.meetings)}</Td>
                      <Td align="right">{fmtInt(p.disqualified)}</Td>
                      <Td align="right">{p.avg_quality ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <div>
            <SectionTitle
              title={t.tmTimelineTitle}
              subtitle={t.tmTimelineSub}
              accent="#0f172a"
              right={
                <span className="ms-auto flex gap-1">
                  {(
                    [
                      ["all", t.tmFilterAll, data.leads.length],
                      ["waiting", t.tmFilterWaiting, waitingCount],
                      ["returning", t.tmFilterReturning, team.returning],
                    ] as const
                  ).map(([key, label, n]) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`tap rounded-lg border px-2.5 py-1 text-xs font-medium ${
                        filter === key
                          ? "border-brand-600 bg-brand-50 text-brand-800"
                          : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {label} <span className="text-slate-400">{fmtInt(n)}</span>
                    </button>
                  ))}
                </span>
              }
            />
            <Card className="overflow-x-auto">
              <LeadTimeline rows={leadRows} />
            </Card>
          </div>
        </>
      )}

      {person && (
        <Profile
          p={person}
          leads={data.leads.filter((l) => l.handler === person.name || l.router === person.name)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * One row per lead, left to right in the order things happened: it arrived,
 * the team leader routed it (or did not), the agent acted (or did not). Every
 * gap is working time, and each one sits in the column of the person it
 * belongs to.
 */
function LeadTimeline({ rows }: { rows: LeadSpeed[] }) {
  const { t, s: stageName, lang, locale } = useLang();
  if (rows.length === 0) return <Empty>{t.tmNoData}</Empty>;

  const est = (l: LeadSpeed) => (l.approx ? "~" : "");
  // Clock time next to working time, when they differ: "0m" for a lead worked
  // at 10:40, before the working day starts, reads as a bug without it.
  const clock = (from: string | null, to: string | null, work: number | null) => {
    if (!from || !to) return null;
    const m = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
    if (work !== null && Math.abs(m - work) < 2) return null;
    return ` · ${fmtWork(m, lang)} ${t.tmClock}`;
  };

  return (
    <table className="w-full min-w-[980px] text-xs">
      <thead className="border-b border-slate-200 bg-slate-100">
        <tr>
          <Th>{t.leads}</Th>
          <Th>{t.tmArrived}</Th>
          <Th>{t.tmRouteCol}</Th>
          <Th>{t.tmAgentCol}</Th>
          <Th>{t.tmPickupCol}</Th>
          <Th align="right">{t.tmTotalCol}</Th>
          <Th>{t.tmStage}</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-200">
        {rows.slice(0, 300).map((l) => {
          const stage = STAGE_BY_STATUS[l.status as Status];
          // A leader who kept the lead is not "the agent" - her work shows
          // in the routing column instead.
          const handlerIsLeader = !!l.handler && TEAM_LEADERS.has(l.handler);
          const agent = l.routed_to ?? (handlerIsLeader ? null : l.handler);

          // ── Routing cell ────────────────────────────────────────────────
          let routing: React.ReactNode;
          if (l.phase === "not_in_crm") {
            routing = <span className="text-slate-400">{t.tmPhase_not_in_crm}</span>;
          } else if (l.returning_since) {
            routing = (
              <span className="text-red-700">
                {t.tmReturningRoute}
                <span className="block text-[10px] text-slate-500">
                  {t.tmReturningSince} {fmtDate(l.returning_since, locale)}
                </span>
              </span>
            );
          } else if (l.auto_routed) {
            routing = <span className="text-slate-500">{t.tmAutoShort}</span>;
          } else if (l.routed_at) {
            routing = (
              <span className={toneText[speedTone(l.route_min, l.approx)]}>
                <span className="font-semibold">
                  {est(l)}
                  {fmtWork(l.route_min, lang)}
                </span>
                <span className="block text-[10px] text-slate-500" dir="auto">
                  {l.router ?? "—"} · {fmtDate(l.routed_at, locale)}
                  {clock(l.arrived_at, l.routed_at, l.route_min)}
                </span>
              </span>
            );
          } else if (l.phase === "awaiting_route") {
            routing = (
              <span className="font-semibold text-red-600">
                {t.tmNotRoutedYet} {fmtWork(l.wait_min, lang)}
                <span className="block text-[10px] font-normal text-slate-500" dir="auto">{l.handler}</span>
              </span>
            );
          } else {
            routing = <span className="text-slate-400">—</span>;
          }
          const selfNote = l.self_handled ? (
            <span className="mt-0.5 block text-[10px] text-emerald-700" dir="auto">
              {l.first_action_by} {t.tmSelfFirst} {est(l)}
              {fmtWork(l.total_min, lang)}
            </span>
          ) : null;

          // ── Agent pickup cell ──────────────────────────────────────────
          let pickup: React.ReactNode;
          if (l.handler_first_at && !handlerIsLeader) {
            pickup = (
              <span className={toneText[speedTone(l.pickup_min, l.approx)]}>
                <span className="font-semibold">
                  {est(l)}
                  {fmtWork(l.pickup_min, lang)}
                </span>
                <span className="block text-[10px] text-slate-500">
                  {fmtDate(l.handler_first_at, locale)}
                  {clock(l.handler_since, l.handler_first_at, l.pickup_min)}
                </span>
              </span>
            );
          } else if (l.phase === "awaiting_agent" && !handlerIsLeader) {
            pickup = (
              <span className="font-semibold text-red-600">
                {t.tmNotYet} {fmtWork(l.wait_min, lang)}
              </span>
            );
          } else if (l.phase === "contacted" && !l.handler_first_at) {
            pickup = <span className="text-slate-500">{t.tmNoAgentAction}</span>;
          } else {
            pickup = <span className="text-slate-400">—</span>;
          }

          return (
            <tr key={l.lead_id} className="align-top">
              <Td>
                <div dir="auto" className="font-medium text-slate-800">
                  {l.full_name || "—"}
                </div>
                <div dir="auto" className="max-w-[16rem] truncate text-[10px] text-slate-400">
                  {l.adset_name || l.campaign_name || ""}
                </div>
                <div className="mt-0.5 flex gap-1">
                  {l.returning_since && (
                    <Badge className="border-red-300 bg-red-50 text-[10px] text-red-700">{t.tmReturningBadge}</Badge>
                  )}
                  {l.approx && (
                    <Badge className="border-amber-300 bg-amber-50 text-[10px] text-amber-700">{t.tmEst}</Badge>
                  )}
                </div>
              </Td>
              <Td className="whitespace-nowrap text-slate-600">{fmtDate(l.arrived_at, locale)}</Td>
              <Td className="whitespace-nowrap">
                {routing}
                {selfNote}
              </Td>
              <Td className="whitespace-nowrap text-slate-700">
                <span dir="auto">{agent ?? "—"}</span>
              </Td>
              <Td className="whitespace-nowrap">{pickup}</Td>
              <Td align="right" className="whitespace-nowrap">
                {l.first_action_at ? (
                  <span className={toneText[speedTone(l.total_min, l.first_approx)]}>
                    {l.first_approx ? "~" : ""}
                    {fmtWork(l.total_min, lang)}
                  </span>
                ) : l.wait_min !== null ? (
                  <span className="text-red-600">
                    {t.tmWaiting} {fmtWork(l.wait_min, lang)}
                  </span>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Td>
              <Td>{stage ? <Badge className={stage.color}>{stageName(l.status as Status)}</Badge> : l.status}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LeaderCard({ p, onOpen }: { p: PersonStats; onOpen: () => void }) {
  const { t, lang } = useLang();
  return (
    <Card
      title={p.name}
      right={
        <button onClick={onOpen} className="text-xs font-medium text-brand-700 hover:underline">
          {t.tmProfile}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2.5 p-4">
        <Stat
          label={t.tmRoutingMedian}
          value={fmtStat(p.routing, lang)}
          sub={`${t.tmRouted} ${fmtInt(p.routed)} · ${t.tmWithin15} ${fmtPct(p.routing.within15)}${p.routing.est ? ` · ${t.tmEstMedian}` : ""}`}
          tone={speedTone(p.routing.median, p.routing.est)}
          accent="#7c3aed"
        />
        <Stat
          label={t.tmAwaitingRoute}
          value={fmtInt(p.awaiting_route)}
          sub={p.oldest_route_wait_min ? `${t.tmColOldest} ${fmtWork(p.oldest_route_wait_min, lang)}` : undefined}
          tone={p.awaiting_route > 0 ? "bad" : "good"}
          accent="#f97316"
        />
        <Stat
          label={t.tmSelfHandled}
          value={fmtInt(p.self_handled)}
          sub={`${t.tmSelfContact} ${fmtStat(p.self_contact, lang)}`}
          accent="#059669"
        />
        <Stat
          label={t.tmOwnLeads}
          value={fmtInt(p.leads)}
          sub={`${t.tmColMedian} ${fmtStat(p.pickup, lang)}`}
          tone={p.leads ? "default" : "muted"}
        />
      </div>
    </Card>
  );
}

function TimeBlock({ label, s }: { label: string; s: TimeStats }) {
  const { t, lang } = useLang();
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneText[speedTone(s.median, s.est)]}`}>
        {fmtStat(s, lang)}
        <span className="ms-1.5 text-xs font-normal text-slate-400">n={s.n}</span>
        {s.est && <span className="ms-1.5 text-xs font-normal text-amber-700">{t.tmEstMedian}</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
        <span>{t.tmWithin15}: {fmtPct(s.within15)}</span>
        <span>{t.tmWithin60}: {fmtPct(s.within60)}</span>
        <span>{t.tmWithinDay}: {fmtPct(s.withinDay)}</span>
      </div>
    </div>
  );
}

function Profile({ p, leads, onClose }: { p: PersonStats; leads: LeadSpeed[]; onClose: () => void }) {
  const { t, lang } = useLang();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = [...leads].sort((a, b) => Date.parse(b.arrived_at) - Date.parse(a.arrived_at));

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative z-10 flex h-full w-full flex-col overflow-y-auto bg-white shadow-panel md:max-w-4xl md:border-s md:border-slate-200">
        <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 dir="auto" className="text-lg font-semibold">
                {p.name}
                {p.is_leader && <Badge className="ms-2 border-violet-300 bg-violet-50 text-violet-800">{t.tmLeaderBadge}</Badge>}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {t.tmProfile} · {fmtInt(rows.length)} {t.tmColLeads}
              </p>
            </div>
            <button onClick={onClose} className="tap -me-1.5 rounded-lg px-2.5 text-lg text-slate-400 hover:bg-slate-100" aria-label={t.close}>
              ✕
            </button>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t.tmSpeed}</h3>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <TimeBlock label={t.tmPickup} s={p.pickup} />
              {p.is_leader && <TimeBlock label={t.tmRouting} s={p.routing} />}
              {p.is_leader && p.self_handled > 0 && <TimeBlock label={t.tmSelfContact} s={p.self_contact} />}
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label={t.tmColLeads} value={fmtInt(p.leads)} />
              <Stat label={t.tmColPicked} value={fmtInt(p.picked_up)} tone="good" />
              <Stat label={t.tmColWaiting} value={fmtInt(p.not_picked_up)} tone={p.not_picked_up ? "bad" : "muted"} />
              <Stat label={t.tmColOldest} value={fmtWork(p.oldest_wait_min, lang)} tone={p.oldest_wait_min ? "bad" : "muted"} />
              {p.is_leader && <Stat label={t.tmRouted} value={fmtInt(p.routed)} />}
              {p.is_leader && (
                <Stat label={t.tmAwaitingRoute} value={fmtInt(p.awaiting_route)} tone={p.awaiting_route ? "bad" : "muted"} />
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t.tmFollowUp}</h3>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <Stat label={t.tmColFollow} value={p.avg_actions === null ? "—" : String(p.avg_actions)} />
              <Stat label={t.tmFollowedUp} value={fmtInt(p.followed_up)} />
              <Stat label={t.tmNoAnswer} value={fmtInt(p.no_answer)} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t.tmOutcomes}</h3>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label={t.tmColQual} value={fmtInt(p.qualified)} tone="good" />
              <Stat label={t.tmColMeet} value={fmtInt(p.meetings)} tone="good" />
              <Stat label={t.tmColDisq} value={fmtInt(p.disqualified)} tone={p.disqualified ? "bad" : "muted"} />
              <Stat label={t.tmColQuality} value={p.avg_quality === null ? "—" : String(p.avg_quality)} />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t.tmLeadList}</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <LeadTimeline rows={rows} />
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
