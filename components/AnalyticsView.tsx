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
  { core: true, key: "avg_quality", tk: "tAvgQuality", kind: "int" },
  { core: true, key: "qualified", tk: "tQual", kind: "int" },
  { core: true, key: "qualified_pct", tk: "tQualPct", kind: "pct" },
  { core: true, key: "cost_per_qualified", tk: "tCostQual", kind: "money2" },
  { key: "site_visits_done", tk: "tVisits", kind: "int" },
  { key: "no_show_pct", tk: "tNoShow", kind: "pct" },
  { core: true, key: "reservations", tk: "tResv", kind: "int" },
  { core: true, key: "cost_per_reservation", tk: "tCostResv", kind: "money2" },
];

export default function AnalyticsView({
  data,
  onSelectCampaign,
}: {
  data: Analytics;
  onSelectCampaign?: (id: string) => void;
}) {
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

  /**
   * The ads, cut by ad set.
   *
   * A campaign's ad sets are the thing being tested against each other, and
   * this account makes the flat list actively misleading: the CAPI test reuses
   * every creative name from the original set, so "03 · Reel" appears twice
   * and the two rows sit wherever spend happens to put them. Grouped by ad
   * set, and keyed on the ad set's ID rather than its name, the comparison is
   * the one the eye actually wants to make.
   *
   * `ads` is already in the chosen sort order, so rows keep it inside each
   * group; the groups themselves are ordered by spend, biggest first.
   */
  const adGroups = useMemo(() => {
    const m = new Map<
      string,
      { key: string; name: string; rows: AdRow[]; spend: number; leads: number; qualified: number; worked: number }
    >();
    for (const a of ads) {
      const key = a.adset_id || a.adset_name || "—";
      const g =
        m.get(key) ??
        { key, name: a.adset_name || t.noAdset, rows: [], spend: 0, leads: 0, qualified: 0, worked: 0 };
      g.rows.push(a);
      g.spend += Number(a.spend ?? 0);
      g.leads += Number(a.leads ?? 0);
      g.qualified += Number(a.qualified ?? 0);
      g.worked += Number(a.worked ?? 0);
      m.set(key, g);
    }
    return [...m.values()].sort((x, y) => y.spend - x.spend);
  }, [ads, t]);

  const maxFunnel = data.funnel[0]?.count ?? 1;
  const statusRows = STAGES.map((st) => ({ ...st, count: data.byStatus?.[st.status as Status] ?? 0 })).filter(
    (st) => st.count > 0
  );
  const totalStatus = statusRows.reduce((sum, st) => sum + st.count, 0);

  const board = data.campaignBoard ?? [];

  return (
    <div className="space-y-6">
      {data.mixedCurrency && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
          {t.mixedCurrency(data.currencies?.join(" · ") || "")}
        </p>
      )}

      {/* ── Campaigns side by side ────────────────────────────────────────
          Only rendered on the all-campaigns view — inside one campaign it
          would just restate the headline. Row click narrows the whole page. */}
      {board.length > 1 && (
        <section>
          <SectionTitle title={t.boardTitle} subtitle={t.boardSub} />
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-start text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <Th>{t.tCampaign}</Th>
                  <Th>{t.tSpend}</Th>
                  <Th>{t.tMetaLeads}</Th>
                  <Th>{t.tLeads}</Th>
                  <Th>{t.tUntouched}</Th>
                  <Th>{t.tNoAnswerCol}</Th>
                  <Th>{t.tQual}</Th>
                  <Th>{t.tQualPct}</Th>
                  <Th>{t.tAvgQuality}</Th>
                  <Th>{t.tCostLead}</Th>
                  <Th>{t.tCostQual}</Th>
                  <Th>{t.tResv}</Th>
                </tr>
              </thead>
              <tbody>
                {board.map((c) => (
                  <tr
                    key={c.campaign_id}
                    onClick={() => onSelectCampaign?.(c.campaign_id)}
                    className="cursor-pointer border-b border-slate-100 transition last:border-0 hover:bg-brand-50/40"
                    title={c.campaign_name}
                  >
                    <Td>
                      <div dir="auto" className="max-w-[16rem] truncate font-medium text-slate-800">
                        {c.campaign_name}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {c.date_start ? `${fmtDay(c.date_start, locale)} → ${c.date_stop ? fmtDay(c.date_stop, locale) : ""}` : ""}
                        {!data.account && (data.accounts?.length ?? 0) > 1 && c.ad_account_id && (
                          <span dir="auto" className="ms-1.5 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-500">
                            {data.accounts?.find((a) => a.ad_account_id === c.ad_account_id)?.name || c.ad_account_id}
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>{fmtMoney(c.spend, c.currency ?? currency)}</Td>
                    <Td>{fmtInt(c.meta_leads)}</Td>
                    <Td>{fmtInt(c.leads)}</Td>
                    <Td>
                      <span className={c.untouched > 0 ? "font-medium text-orange-600" : ""}>{fmtInt(c.untouched)}</span>
                    </Td>
                    <Td>{fmtInt(c.no_answer)}</Td>
                    <Td>{fmtInt(c.qualified)}</Td>
                    <Td>
                      {c.avg_quality != null ? (
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${
                            c.avg_quality >= 55
                              ? "bg-emerald-50 text-emerald-700"
                              : c.avg_quality >= 30
                                ? "bg-amber-50 text-amber-700"
                                : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {c.avg_quality}
                        </span>
                      ) : (
                        "\u2014"
                      )}
                    </Td>
                    <Td>
                      <span className={
                        c.qualified_pct == null ? "" : c.qualified_pct >= 10 ? "font-semibold text-emerald-600" : c.qualified_pct < 3 ? "text-red-600" : ""
                      }>
                        {fmtPct(c.qualified_pct)}
                      </span>
                    </Td>
                    <Td>{c.cost_per_lead == null ? "—" : fmtMoney2(c.cost_per_lead, c.currency ?? currency)}</Td>
                    <Td>{c.cost_per_qualified == null ? "—" : fmtMoney2(c.cost_per_qualified, c.currency ?? currency)}</Td>
                    <Td>{fmtInt(c.reservations)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
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
        subtitle={t.adPerfGrouped}
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
          <div className="md:hidden">
            {adGroups.map((g) => (
              <section key={g.key}>
                <h3
                  dir="auto"
                  className="border-y border-slate-200 bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-700"
                >
                  {g.name}
                  <span className="ms-2 font-normal tabular-nums text-slate-500">
                    {fmtMoney(g.spend, currency)} · {fmtInt(g.leads)} {t.leadsUnit}
                  </span>
                </h3>
                <ul className="divide-y divide-slate-200">
            {g.rows.map((a) => (
              <li key={a.ad_id} className="px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span dir="auto" className="truncate font-semibold text-slate-900">{a.ad_name || "—"}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {fmtMoney(a.spend, currency)}
                  </span>
                </div>

                <dl className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                  {[
                    { k: t.tLeads, v: fmtInt(a.leads) },
                    { k: t.tCostLead, v: fmtMoney2(a.cost_per_lead, currency) },
                    { k: t.tQualPct, v: a.worked === 0 ? "—" : fmtPct(a.qualified_pct) },
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
              </section>
            ))}
          </div>

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
              {/* One tbody per ad set: a real group, with its own subtotal
                  row, rather than a flat list where two ads sharing a creative
                  name land wherever spend happens to put them. */}
              {adGroups.map((g) => (
              <tbody key={g.key} className="divide-y divide-slate-200 border-b-2 border-slate-200">
                <tr className="bg-slate-100/80">
                  <Td className="py-2">
                    <span dir="auto" className="text-xs font-semibold text-slate-700">{g.name}</span>
                  </Td>
                  <Td align="right" className="py-2 text-xs font-semibold text-slate-700">
                    {fmtMoney(g.spend, currency)}
                  </Td>
                  <Td align="right" className="py-2 text-xs font-semibold text-slate-700">
                    {fmtInt(g.leads)}
                  </Td>
                  {columns.slice(3).map((c) => (
                    <Td key={c.key} align="right" className="py-2 text-xs text-slate-500">
                      {c.key === "qualified_pct"
                        ? g.worked === 0
                          ? "—"
                          : fmtPct(Math.round((1000 * g.qualified) / g.leads) / 10)
                        : c.key === "qualified"
                          ? fmtInt(g.qualified)
                          : c.key === "cost_per_lead"
                            ? fmtMoney2(g.leads ? g.spend / g.leads : null, currency)
                            : c.key === "cost_per_qualified"
                              ? fmtMoney2(g.qualified ? g.spend / g.qualified : null, currency)
                              : ""}
                    </Td>
                  ))}
                </tr>
                {g.rows.map((a) => (
                  <tr key={a.ad_id} className="even:bg-slate-50/70 hover:bg-sky-50">
                    {columns.map((c) => {
                      const v = a[c.key];
                      if (c.kind === "text") {
                        return (
                          <Td key={c.key}>
                            <div dir="auto" className="ps-3 font-medium text-slate-900">{a.ad_name || "—"}</div>
                            <div dir="auto" className="ps-3 text-xs text-slate-400">{a.campaign_name || ""}</div>
                          </Td>
                        );
                      }
                      const text =
                        c.key === "qualified_pct" && a.worked === 0
                          ? "—"
                          : c.kind === "int"
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
              ))}
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
                    {fmtInt(p.leads)} {t.leadsUnit} ·{" "}
                    {p.qualified_pct === null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className="text-emerald-600">{fmtPct(p.qualified_pct)} {t.qualShort}</span>
                    )}
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
              return (
                <div key={seg.field}>
                  <h3 dir="auto" className="text-xs font-semibold text-slate-600">{seg.label || seg.field}</h3>
                  <div className="mt-2.5 space-y-2.5">
                    {seg.values.map((v) => (
                      <div key={v.value}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span dir="auto" className="truncate text-slate-700">{v.label || v.value}</span>
                          <span className="shrink-0 tabular-nums text-slate-500">
                            {fmtInt(v.leads)} {t.leadsUnit} ·{" "}
                            {v.qualified_pct === null ? (
                              <span className="text-slate-400">—</span>
                            ) : (
                              <span
                                className={
                                  v.leads < 10
                                    ? "text-slate-400"
                                    : Number(v.qualified_pct) >= 30
                                      ? "text-emerald-600"
                                      : "text-slate-500"
                                }
                                title={v.leads < 10 ? t.smallSample : undefined}
                              >
                                {fmtPct(v.qualified_pct)} {t.qualShort}
                                {v.leads < 10 ? " *" : ""}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1">
                          {/* The bar is the QUALIFICATION RATE, on a fixed 0-100
                              scale. It used to be the lead count, which read
                              exactly backwards: the answer with the best rate
                              in the whole card (80%) drew the shortest bar
                              because only five people picked it, while the most
                              popular answer looked like the best one. Length
                              and colour now say the same thing.

                              Below ten leads a rate is noise - one more call
                              moves it twenty points - so those are drawn grey
                              and labelled instead of ranked on. */}
                          <Bar
                            value={v.qualified_pct === null ? 0 : Number(v.qualified_pct)}
                            max={100}
                            color={
                              v.leads < 10
                                ? "#cbd5e1"
                                : Number(v.qualified_pct) >= 40
                                  ? "#059669"
                                  : Number(v.qualified_pct) >= 15
                                    ? "#f59e0b"
                                    : "#ef4444"
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
