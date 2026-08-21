"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { Bar, Card, Columns, Empty, Stat, Td, Th, fmtDay, fmtInt, fmtMoney, fmtMoney2, fmtPct } from "./ui";
import type { Analytics, AdRow } from "./types";

type SortKey = keyof AdRow;

/** Columns of the ad table, so header and body can never drift apart. */
const AD_COLUMNS: { key: SortKey; label: string; kind: "text" | "int" | "money" | "money2" | "pct" | "num" }[] = [
  { key: "ad_name", label: "Ad", kind: "text" },
  { key: "spend", label: "Spend", kind: "money" },
  { key: "reach", label: "Reach", kind: "int" },
  { key: "impressions", label: "Impr.", kind: "int" },
  { key: "frequency", label: "Freq.", kind: "num" },
  { key: "ctr", label: "CTR", kind: "pct" },
  { key: "cpm", label: "CPM", kind: "money2" },
  { key: "leads", label: "Leads", kind: "int" },
  { key: "cost_per_lead", label: "Cost / lead", kind: "money2" },
  { key: "qualified", label: "Qual.", kind: "int" },
  { key: "qualified_pct", label: "Qual. %", kind: "pct" },
  { key: "cost_per_qualified", label: "Cost / qual.", kind: "money2" },
  { key: "site_visits_done", label: "Visits", kind: "int" },
  { key: "no_show_pct", label: "No-show", kind: "pct" },
  { key: "reservations", label: "Resv.", kind: "int" },
  { key: "cost_per_reservation", label: "Cost / resv.", kind: "money2" },
];

export default function AnalyticsView({ data }: { data: Analytics }) {
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
  const statusRows = STAGES.map((s) => ({ ...s, count: data.byStatus?.[s.status as Status] ?? 0 })).filter(
    (s) => s.count > 0
  );
  const totalStatus = statusRows.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="space-y-6">
      {/* ── Money first: these are the numbers that decide budget ─────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Spend" value={fmtMoney(kpis.spend, currency)} sub={`${fmtInt(kpis.reach)} reached`} />
        <Stat label="Leads" value={fmtInt(kpis.leads)} sub={`${fmtInt(kpis.untouched)} untouched`} />
        <Stat label="Cost / lead" value={fmtMoney2(kpis.cost_per_lead, currency)} />
        <Stat
          label="Qualified"
          value={fmtInt(kpis.qualified)}
          sub={`${fmtPct(kpis.qualified_pct)} of leads`}
          tone="good"
        />
        <Stat label="Cost / qualified" value={fmtMoney2(kpis.cost_per_qualified, currency)} tone="good" />
        <Stat
          label="Reservations"
          value={fmtInt(kpis.reservations)}
          sub={kpis.cost_per_reservation ? `${fmtMoney2(kpis.cost_per_reservation, currency)} each` : undefined}
          tone={kpis.reservations > 0 ? "good" : "muted"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Impressions" value={fmtInt(kpis.impressions)} />
        <Stat label="Clicks" value={fmtInt(kpis.clicks)} sub={kpis.ctr ? `${kpis.ctr}% CTR` : undefined} />
        <Stat label="Site visits" value={fmtInt(kpis.site_visits)} />
        <Stat label="Cost / site visit" value={fmtMoney2(kpis.cost_per_site_visit, currency)} />
        <Stat
          label="Median response"
          value={kpis.median_response_hours === null ? "—" : `${kpis.median_response_hours}h`}
          sub={kpis.contacted_within_hour_pct === null ? undefined : `${kpis.contacted_within_hour_pct}% within 1h`}
          tone={kpis.median_response_hours !== null && kpis.median_response_hours > 4 ? "bad" : "default"}
        />
        <Stat
          label="Reservation value"
          value={kpis.reservation_value ? fmtMoney(kpis.reservation_value, currency) : "—"}
          sub={kpis.roas ? `${kpis.roas}× on spend` : undefined}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ── Funnel ───────────────────────────────────────────────────────── */}
        <Card
          title="Pipeline funnel"
          subtitle="Each step counts every lead that reached it or went past it"
          className="xl:col-span-2"
        >
          <div className="space-y-3 px-5 py-4">
            {data.funnel.map((step, i) => (
              <div key={step.status}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-slate-800">{step.label}</span>
                  <span className="flex items-baseline gap-3 tabular-nums">
                    <span className="font-semibold">{fmtInt(step.count)}</span>
                    <span className="w-12 text-right text-xs text-slate-400">{fmtPct(step.ofTotal)}</span>
                    <span
                      className={`w-20 text-right text-xs ${
                        i === 0 ? "text-transparent" : step.fromPrev !== null && step.fromPrev < 30 ? "text-red-500" : "text-slate-500"
                      }`}
                    >
                      {i === 0 ? "—" : `${fmtPct(step.fromPrev)} of prev`}
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
        <Card title="Current status" subtitle="Every lead sits in exactly one">
          {statusRows.length === 0 ? (
            <Empty>No leads yet.</Empty>
          ) : (
            <div className="space-y-2.5 px-5 py-4">
              {statusRows.map((s) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-slate-700">{s.label}</span>
                  <div className="flex-1">
                    <Bar value={s.count} max={totalStatus} color={s.accent} />
                  </div>
                  <span className="w-8 text-right text-sm font-medium tabular-nums">{s.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Per-ad performance ─────────────────────────────────────────────── */}
      <Card
        title="Ad performance"
        subtitle="Delivery and spend from Meta, pipeline from your team — click a column to sort"
      >
        {ads.length === 0 ? (
          <Empty>No ad data yet. It arrives with the next sync.</Empty>
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
                        {c.label}
                        {sort.key === c.key && <span className="ml-0.5">{sort.dir === -1 ? "↓" : "↑"}</span>}
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
        <Card title="Leads per day" subtitle="Green is the qualified share" className="xl:col-span-2">
          {data.daily.length === 0 ? (
            <Empty>Nothing to plot yet.</Empty>
          ) : (
            <div className="px-4 py-5">
              <Columns
                data={data.daily.slice(-30).map((d) => ({
                  label: fmtDay(d.date),
                  value: d.leads,
                  secondary: d.qualified,
                }))}
              />
            </div>
          )}
        </Card>

        <Card title="Platform" subtitle="Where the form was filled">
          {data.platforms.length === 0 ? (
            <Empty>—</Empty>
          ) : (
            <div className="space-y-3 px-5 py-4">
              {data.platforms.map((p) => (
                <div key={p.platform} className="flex items-center justify-between text-sm">
                  <span className="uppercase text-slate-700">{p.platform}</span>
                  <span className="tabular-nums text-slate-500">
                    {fmtInt(p.leads)} · <span className="text-emerald-600">{fmtPct(p.qualified_pct)} qual.</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Do the qualifier questions actually qualify? ────────────────────── */}
      <Card
        title="What the form answers predict"
        subtitle="If an answer does not separate good leads from bad, the question is not earning its place on the form"
      >
        {data.segments.length === 0 ? (
          <Empty>Not enough repeated answers yet.</Empty>
        ) : (
          <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
            {data.segments.map((seg) => {
              const max = Math.max(...seg.values.map((v) => v.leads), 1);
              return (
                <div key={seg.field}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {seg.field.replace(/_/g, " ")}
                  </h3>
                  <div className="mt-2.5 space-y-2.5">
                    {seg.values.map((v) => (
                      <div key={v.value}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate text-slate-700">{v.value.replace(/_/g, " ")}</span>
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
