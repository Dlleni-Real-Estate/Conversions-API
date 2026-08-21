"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { Bar, Card, Columns, Empty, Stat, Td, Th, fmtDay, fmtInt, fmtMoney, fmtMoney2, fmtPct } from "./ui";
import { useLang } from "./LangProvider";
import type { Analytics, AdRow } from "./types";

type SortKey = keyof AdRow;

/** Columns of the ad table, so header and body can never drift apart. */
type ColKind = "text" | "int" | "money" | "money2" | "pct" | "num";
const AD_COLUMNS: { key: SortKey; tk: keyof ReturnType<typeof useLang>["t"]; kind: ColKind }[] = [
  { key: "ad_name", tk: "tAd", kind: "text" },
  { key: "spend", tk: "tSpend", kind: "money" },
  { key: "reach", tk: "tReach", kind: "int" },
  { key: "impressions", tk: "tImpr", kind: "int" },
  { key: "frequency", tk: "tFreq", kind: "num" },
  { key: "ctr", tk: "tCtr", kind: "pct" },
  { key: "cpm", tk: "tCpm", kind: "money2" },
  { key: "leads", tk: "tLeads", kind: "int" },
  { key: "cost_per_lead", tk: "tCostLead", kind: "money2" },
  { key: "qualified", tk: "tQual", kind: "int" },
  { key: "qualified_pct", tk: "tQualPct", kind: "pct" },
  { key: "cost_per_qualified", tk: "tCostQual", kind: "money2" },
  { key: "site_visits_done", tk: "tVisits", kind: "int" },
  { key: "no_show_pct", tk: "tNoShow", kind: "pct" },
  { key: "reservations", tk: "tResv", kind: "int" },
  { key: "cost_per_reservation", tk: "tCostResv", kind: "money2" },
];

export default function AnalyticsView({ data }: { data: Analytics }) {
  const { t, s: stageName, locale } = useLang();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  const { kpis, currency } = data;

  const ads = useMemo(() => {
    const rows = [...(data.ads || [])];
    rows.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av ?? "").localeCompare(String(bv ?? "")) * sort.dir;
      }
      // Nulls always sink, whichever direction we are sorting.
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (Number(av) - Number(bv)) * sort.dir;
    });
    return rows;
  }, [data.ads, sort]);

  const maxFunnel = data.funnel[0]?.count ?? 1;
  const statusRows = STAGES.map((st) => ({ ...st, count: data.byStatus?.[st.status as Status] ?? 0 })).filter(
    (st) => st.count > 0
  );
  const totalStatus = statusRows.reduce((sum, st) => sum + st.count, 0);

  return (
    <div className="space-y-6">
      {/* ── Money first: these are the numbers that decide budget ─────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label={t.spend} value={fmtMoney(kpis.spend, currency)} sub={`${fmtInt(kpis.reach)} ${t.reached}`} />
        <Stat label={t.leads} value={fmtInt(kpis.leads)} sub={`${fmtInt(kpis.untouched)} ${t.untouched}`} />
        <Stat label={t.costPerLead} value={fmtMoney2(kpis.cost_per_lead, currency)} />
        <Stat
          label={t.qualified}
          value={fmtInt(kpis.qualified)}
          sub={`${fmtPct(kpis.qualified_pct)} ${t.ofLeads}`}
          tone="good"
        />
        <Stat label={t.costPerQualified} value={fmtMoney2(kpis.cost_per_qualified, currency)} tone="good" />
        <Stat
          label={t.reservations}
          value={fmtInt(kpis.reservations)}
          sub={kpis.cost_per_reservation ? `${fmtMoney2(kpis.cost_per_reservation, currency)} ${t.each}` : undefined}
          tone={kpis.reservations > 0 ? "good" : "muted"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label={t.impressions} value={fmtInt(kpis.impressions)} />
        <Stat label={t.clicks} value={fmtInt(kpis.clicks)} sub={kpis.ctr ? `${kpis.ctr}% ${t.ctrSuffix}` : undefined} />
        <Stat label={t.siteVisits} value={fmtInt(kpis.site_visits)} />
        <Stat label={t.costPerSiteVisit} value={fmtMoney2(kpis.cost_per_site_visit, currency)} />
        <Stat
          label={t.medianResponse}
          value={kpis.median_response_hours === null ? "—" : `${kpis.median_response_hours}h`}
          sub={kpis.contacted_within_hour_pct === null ? undefined : t.withinHour(kpis.contacted_within_hour_pct)}
          tone={kpis.median_response_hours !== null && kpis.median_response_hours > 4 ? "bad" : "default"}
        />
        <Stat
          label={t.reservationValue}
          value={kpis.reservation_value ? fmtMoney(kpis.reservation_value, currency) : "—"}
          sub={kpis.roas ? t.onSpend(kpis.roas) : undefined}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ── Funnel ───────────────────────────────────────────────────────── */}
        <Card
          title={t.funnelTitle}
          subtitle={t.funnelSub}
          className="xl:col-span-2"
        >
          <div className="space-y-3 px-5 py-4">
            {data.funnel.map((step, i) => (
              <div key={step.status}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-slate-800">
                    {step.status === "lead" ? t.leads : stageName(step.status as Status)}
                  </span>
                  <span className="flex items-baseline gap-3 tabular-nums">
                    <span className="font-semibold">{fmtInt(step.count)}</span>
                    <span className="w-12 text-right text-xs text-slate-400">{fmtPct(step.ofTotal)}</span>
                    <span
                      className={`w-20 text-right text-xs ${
                        i === 0 ? "text-transparent" : step.fromPrev !== null && step.fromPrev < 30 ? "text-red-500" : "text-slate-500"
                      }`}
                    >
                      {i === 0 ? "—" : `${fmtPct(step.fromPrev)} ${t.ofPrev}`}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5">
                  <Bar value={step.count} max={maxFunnel} color={step.accent} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Where everyone is sitting right now ──────────────────────────── */}
        <Card title={t.currentStatus} subtitle={t.currentStatusSub}>
          {statusRows.length === 0 ? (
            <Empty>{t.noLeads}</Empty>
          ) : (
            <div className="space-y-2.5 px-5 py-4">
              {statusRows.map((st) => (
                <div key={st.status} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-slate-700">{stageName(st.status)}</span>
                  <div className="flex-1">
                    <Bar value={st.count} max={totalStatus} color={st.accent} />
                  </div>
                  <span className="w-8 text-end text-sm font-medium tabular-nums">{st.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Per-ad performance ─────────────────────────────────────────────── */}
      <Card
        title={t.adPerf}
        subtitle={t.adPerfSub}
      >
        {ads.length === 0 ? (
          <Empty>{t.noAdData}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 bg-slate-50/60">
                <tr>
                  {AD_COLUMNS.map((c) => (
                    <Th key={c.key} align={c.kind === "text" ? "left" : "right"}>
                      <button
                        onClick={() =>
                          setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === -1 ? 1 : -1 }))
                        }
                        className="hover:text-slate-900"
                      >
                        {t[c.tk] as string}
                        {sort.key === c.key && <span className="ms-0.5">{sort.dir === -1 ? "↓" : "↑"}</span>}
                      </button>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ads.map((a) => (
                  <tr key={a.ad_id} className="hover:bg-slate-50/60">
                    {AD_COLUMNS.map((c) => {
                      const v = a[c.key];
                      if (c.kind === "text") {
                        return (
                          <Td key={c.key}>
                            <div className="font-medium text-slate-900">{a.ad_name || "—"}</div>
                            <div className="text-xs text-slate-400">{a.adset_name || ""}</div>
                          </Td>
                        );
                      }
                      const text =
                        c.kind === "int"
                          ? fmtInt(v as number)
                          : c.kind === "money"
                            ? fmtMoney(v as number, currency)
                            : c.kind === "money2"
                              ? fmtMoney2(v as number, currency)
                              : c.kind === "pct"
                                ? fmtPct(v as number)
                                : v === null || v === undefined
                                  ? "—"
                                  : Number(v).toFixed(2);
                      const emphasis =
                        c.key === "cost_per_qualified" || c.key === "cost_per_reservation"
                          ? "font-medium text-slate-900"
                          : c.key === "no_show_pct" && Number(v) > 40
                            ? "text-red-600"
                            : c.key === "qualified_pct" && Number(v) >= 30
                              ? "text-emerald-600"
                              : "text-slate-600";
                      return (
                        <Td key={c.key} align="right" className={emphasis}>
                          {text}
                        </Td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ── Volume over time ─────────────────────────────────────────────── */}
        <Card title={t.perDay} subtitle={t.perDaySub} className="xl:col-span-2">
          {data.daily.length === 0 ? (
            <Empty>{t.nothingToPlot}</Empty>
          ) : (
            <div className="px-4 py-5">
              <Columns
                secondaryLabel={t.qualShort}
                data={data.daily.slice(-30).map((d) => ({
                  label: fmtDay(d.date, locale),
                  value: d.leads,
                  secondary: d.qualified,
                }))}
              />
            </div>
          )}
        </Card>

        <Card title={t.platform} subtitle={t.platformSub}>
          {data.platforms.length === 0 ? (
            <Empty>—</Empty>
          ) : (
            <div className="space-y-3 px-5 py-4">
              {data.platforms.map((p) => (
                <div key={p.platform} className="flex items-center justify-between text-sm">
                  <span className="uppercase text-slate-700">{p.platform}</span>
                  <span className="tabular-nums text-slate-500">
                    {fmtInt(p.leads)} · <span className="text-emerald-600">{fmtPct(p.qualified_pct)} {t.qualShort}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Do the qualifier questions actually qualify? ────────────────────── */}
      <Card
        title={t.segmentsTitle}
        subtitle={t.segmentsSub}
      >
        {data.segments.length === 0 ? (
          <Empty>{t.notEnoughAnswers}</Empty>
        ) : (
          <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
            {data.segments.map((seg) => {
              const max = Math.max(...seg.values.map((v) => v.leads), 1);
              return (
                <div key={seg.field}>
                  <h3 className="text-xs font-semibold text-slate-600">{seg.label || seg.field}</h3>
                  <div className="mt-2.5 space-y-2.5">
                    {seg.values.map((v) => (
                      <div key={v.value}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate text-slate-700">{v.label || v.value}</span>
                          <span className="shrink-0 tabular-nums text-slate-500">
                            {v.leads} ·{" "}
                            <span className={Number(v.qualified_pct) >= 30 ? "text-emerald-600" : "text-slate-400"}>
                              {fmtPct(v.qualified_pct)}
                            </span>
                          </span>
                        </div>
                        <div className="mt-1">
                          <Bar value={v.leads} max={max} color={STAGE_BY_STATUS.qualified.accent} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
