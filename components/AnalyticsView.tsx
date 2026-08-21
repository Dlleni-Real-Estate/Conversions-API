"use client";

import { useMemo, useState } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { Bar, Card, Columns, Empty, MetricGrid, SectionTitle, Stat, Td, Th, fmtDay, fmtInt, fmtMoney, fmtMoney2, fmtPct } from "./ui";
import { useLang } from "./LangProvider";
import type { Analytics, AdRow } from "./types";

type SortKey = keyof AdRow;

/** Columns of the ad table, so header and body can never drift apart. */
type ColKind = "text" | "int" | "money" | "money2" | "pct" | "num";
/** `core: true` survives the Essentials view — the rest is for a wide screen. */
const AD_COLUMNS: { key: SortKey; tk: keyof ReturnType<typeof useLang>["t"]; kind: ColKind; core?: boolean }[] = [
  { core: true, key: "ad_name", tk: "tAd", kind: "text" },
  { core: true, key: "spend", tk: "tSpend", kind: "money" },
  { key: "reach", tk: "tReach", kind: "int" },
  { key: "impressions", tk: "tImpr", kind: "int" },
  { key: "frequency", tk: "tFreq", kind: "num" },
  { key: "ctr", tk: "tCtr", kind: "pct" },
  { key: "cpm", tk: "tCpm", kind: "money2" },
  { key: "meta_leads", tk: "tMetaLeads", kind: "int" },
  { key: "meta_cost_per_lead", tk: "tMetaCostLead", kind: "money2" },
  { core: true, key: "leads", tk: "tLeads", kind: "int" },
  { core: true, key: "cost_per_lead", tk: "tCostLead", kind: "money2" },
  { core: true, key: "qualified", tk: "tQual", kind: "int" },
  { core: true, key: "qualified_pct", tk: "tQualPct", kind: "pct" },
  { core: true, key: "cost_per_qualified", tk: "tCostQual", kind: "money2" },
  { key: "site_visits_done", tk: "tVisits", kind: "int" },
  { key: "no_show_pct", tk: "tNoShow", kind: "pct" },
  { core: true, key: "reservations", tk: "tResv", kind: "int" },
  { core: true, key: "cost_per_reservation", tk: "tCostResv", kind: "money2" },
];

export default function AnalyticsView({ data }: { data: Analytics }) {
  const { t, s: stageName, locale } = useLang();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  const [wide, setWide] = useState(false);
  const columns = wide ? AD_COLUMNS : AD_COLUMNS.filter((c) => c.core);
  const { kpis, meta, currency } = data;

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
      {/* ── Meta's own numbers, verbatim ──────────────────────────────────
          Nothing in this block is computed from our lead table. Reach in
          particular is never added across campaigns: it counts people, and Meta
          has already deduplicated anyone who saw more than one ad. */}
      <section>
        <SectionTitle
          title={t.fromMeta}
          subtitle={t.fromMetaSub}
          accent="#1877f2"
          right={
            meta.date_stop ? (
              <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                {t.reportedThrough(fmtDay(meta.date_stop, locale))}
              </span>
            ) : undefined
          }
        />
        <MetricGrid
          moreLabel={t.showAllMetrics}
          lessLabel={t.showFewer}
          core={
            <>
              <Stat label={t.spend} value={fmtMoney(meta.spend, currency)} accent="#1877f2" />
              <Stat
                label={t.reached}
                value={meta.reach === null ? "—" : fmtInt(meta.reach)}
                sub={meta.reach === null ? t.reachAcrossCampaigns : undefined}
                tone={meta.reach === null ? "muted" : "default"}
              />
              <Stat label={t.metaLeads} value={fmtInt(meta.leads)} />
              <Stat label={t.costPerLead} value={fmtMoney2(meta.cost_per_lead, currency)} accent="#1877f2" />
            </>
          }
          more={
            <>
              <Stat label={t.impressions} value={fmtInt(meta.impressions)} />
              <Stat
                label={t.frequency}
                value={meta.frequency === null ? "—" : meta.frequency.toFixed(2)}
                tone={meta.frequency === null ? "muted" : "default"}
              />
              <Stat
                label={t.clicks}
                value={fmtInt(meta.clicks)}
                sub={`${fmtInt(meta.link_clicks)} ${t.linkClicks.toLowerCase()}`}
              />
              <Stat label={t.ctrSuffix} value={fmtPct(meta.ctr)} />
              <Stat label={t.cpm} value={fmtMoney2(meta.cpm, currency)} />
              <Stat label={t.cpc} value={fmtMoney2(meta.cpc, currency)} />
            </>
          }
        />
        <p className="mt-2 max-w-4xl text-[11px] leading-relaxed text-slate-400">{t.metaLagNote}</p>
      </section>

      {/* ── Our pipeline. Same spend, our counts. ─────────────────────────── */}
      <section>
        <SectionTitle title={t.yourPipeline} subtitle={t.yourPipelineSub} accent="#10b981" />
        <MetricGrid
          moreLabel={t.showAllMetrics}
          lessLabel={t.showFewer}
          core={
            <>
              <Stat
                label={t.crmLeads}
                value={fmtInt(kpis.leads)}
                sub={`${fmtInt(kpis.untouched)} ${t.untouched}`}
                accent="#0ea5e9"
              />
              <Stat
                label={t.qualified}
                value={fmtInt(kpis.qualified)}
                sub={`${fmtPct(kpis.qualified_pct)} ${t.ofLeads}`}
                tone="good"
              />
              <Stat
                label={t.costPerQualified}
                value={fmtMoney2(kpis.cost_per_qualified, currency)}
                tone="good"
                accent="#10b981"
              />
              <Stat
                label={t.medianResponse}
                value={kpis.median_response_hours === null ? "—" : `${kpis.median_response_hours}h`}
                sub={kpis.contacted_within_hour_pct === null ? undefined : t.withinHour(kpis.contacted_within_hour_pct)}
                tone={kpis.median_response_hours !== null && kpis.median_response_hours > 4 ? "bad" : "default"}
              />
            </>
          }
          more={
            <>
              <Stat label={t.costPerLead} value={fmtMoney2(kpis.cost_per_lead, currency)} />
              <Stat label={t.siteVisits} value={fmtInt(kpis.site_visits)} />
              <Stat label={t.costPerSiteVisit} value={fmtMoney2(kpis.cost_per_site_visit, currency)} />
              <Stat
                label={t.reservations}
                value={fmtInt(kpis.reservations)}
                sub={kpis.cost_per_reservation ? `${fmtMoney2(kpis.cost_per_reservation, currency)} ${t.each}` : undefined}
                tone={kpis.reservations > 0 ? "good" : "muted"}
              />
              <Stat
                label={t.reservationValue}
                value={kpis.reservation_value ? fmtMoney(kpis.reservation_value, currency) : "—"}
                sub={kpis.roas ? t.onSpend(kpis.roas) : undefined}
              />
            </>
          }
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* ── Funnel ───────────────────────────────────────────────────────── */}
        <Card
          title={t.funnelTitle}
          subtitle={t.funnelSub}
          className="xl:col-span-2"
        >
          <div className="space-y-4 px-5 py-4">
            {data.funnel.map((step, i) => (
              <div key={step.status}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-slate-800">
                    {step.status === "lead" ? t.leads : stageName(step.status as Status)}
                  </span>
                  <span className="flex items-baseline gap-2 whitespace-nowrap tabular-nums sm:gap-3">
                    <span className="font-semibold">{fmtInt(step.count)}</span>
                    <span className="w-11 text-end text-xs text-slate-400">{fmtPct(step.ofTotal)}</span>
                    <span
                      className={`hidden w-16 text-end text-xs sm:inline ${
                        i === 0 ? "text-transparent" : step.fromPrev !== null && step.fromPrev < 30 ? "text-red-500" : "text-slate-500"
                      }`}
                    >
                      {i === 0 ? "—" : fmtPct(step.fromPrev)}
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
        right={
          <button
            onClick={() => setWide((v) => !v)}
            className="tap hidden whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium shadow-card hover:bg-slate-50 md:block"
          >
            {wide ? t.essentials : t.allColumns}
          </button>
        }
      >
        {ads.length === 0 ? (
          <Empty>{t.noAdData}</Empty>
        ) : (
          <>
            {/* Phone: an 18-column table is unusable on a thumb, so each ad
                becomes a card carrying only the numbers that change a
                decision. */}
          <ul className="divide-y divide-slate-200 md:hidden">
            {ads.map((a) => (
              <li key={a.ad_id} className="px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span dir="auto" className="truncate font-semibold text-slate-900">{a.ad_name || "—"}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {fmtMoney(a.spend, currency)}
                  </span>
                </div>
                <div dir="auto" className="mt-0.5 truncate text-[11px] text-slate-400">{a.adset_name || ""}</div>

                <dl className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  {[
                    { k: t.tLeads, v: fmtInt(a.leads) },
                    { k: t.tCostLead, v: fmtMoney2(a.cost_per_lead, currency) },
                    { k: t.tQualPct, v: fmtPct(a.qualified_pct) },
                    { k: t.tReach, v: fmtInt(a.reach) },
                    { k: t.tCtr, v: fmtPct(a.ctr) },
                    { k: t.tCostQual, v: fmtMoney2(a.cost_per_qualified, currency) },
                  ].map((cell) => (
                    <div key={cell.k} className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{cell.k}</dt>
                      <dd className="text-sm font-semibold tabular-nums text-slate-900">{cell.v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-100">
                <tr>
                  {columns.map((c) => (
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
              <tbody className="divide-y divide-slate-200">
                {ads.map((a) => (
                  <tr key={a.ad_id} className="even:bg-slate-50/70 hover:bg-sky-50">
                    {columns.map((c) => {
                      const v = a[c.key];
                      if (c.kind === "text") {
                        return (
                          <Td key={c.key}>
                            <div dir="auto" className="font-medium text-slate-900">{a.ad_name || "—"}</div>
                            <div dir="auto" className="text-xs text-slate-400">{a.adset_name || ""}</div>
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
          </>
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
                className="sm:hidden"
                secondaryLabel={t.qualShort}
                data={data.daily.slice(-10).map((d) => ({
                  label: d.date.slice(-2),
                  value: d.leads,
                  secondary: d.qualified,
                }))}
              />
              <Columns
                className="hidden sm:flex"
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
            <div className="space-y-4 px-5 py-4">
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
                  <h3 dir="auto" className="text-xs font-semibold text-slate-600">{seg.label || seg.field}</h3>
                  <div className="mt-2.5 space-y-2.5">
                    {seg.values.map((v) => (
                      <div key={v.value}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span dir="auto" className="truncate text-slate-700">{v.label || v.value}</span>
                          <span className="shrink-0 tabular-nums text-slate-500">
                            {v.leads} ·{" "}
                            <span className={Number(v.qualified_pct) >= 30 ? "text-emerald-600" : "text-slate-400"}>
                              {fmtPct(v.qualified_pct)}
                            </span>
                          </span>
                        </div>
                        <div className="mt-1">
                          {/* Colour carries the verdict: an answer that turns
                              into qualified leads is green, one that does not
                              is grey. */}
                          <Bar
                            value={v.leads}
                            max={max}
                            color={
                              Number(v.qualified_pct) >= 40
                                ? "#059669"
                                : Number(v.qualified_pct) >= 15
                                  ? "#f59e0b"
                                  : "#cbd5e1"
                            }
                          />
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
