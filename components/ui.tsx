"use client";

import type { ReactNode } from "react";

// ── Formatting ──────────────────────────────────────────────────────────────
// One place, so a number never renders two different ways on two screens.

export const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString("en-US");

export const fmtMoney = (n: number | null | undefined, currency = "EGP") =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${currency}`;

export const fmtMoney2 = (n: number | null | undefined, currency = "EGP") =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${currency}`;

export const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : `${Number(n)}%`;

export const fmtDate = (iso: string | null | undefined) =>
  !iso
    ? "—"
    : new Date(iso).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });

export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

/** "3h ago", "2d ago" — for how long a lead has been sitting untouched. */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ── Primitives ──────────────────────────────────────────────────────────────

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "bad" | "muted";
}) {
  const toneClass = {
    default: "text-slate-900",
    good: "text-emerald-600",
    bad: "text-red-600",
    muted: "text-slate-400",
  }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-14 text-center text-sm text-slate-400">{children}</div>;
}

/** Horizontal proportion bar — used by the funnel and the segment tables. */
export function Bar({ value, max, color = "#0f172a" }: { value: number; max: number; color?: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full transition-all" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}

/** Small column chart. No chart library — this is 20 lines and always matches the theme. */
export function Columns({
  data,
  height = 120,
}: {
  data: { label: string; value: number; secondary?: number }[];
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto px-1" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="group flex min-w-[26px] flex-1 flex-col items-center justify-end gap-1">
          <div className="relative w-full">
            <div
              className="w-full rounded-t bg-slate-200 transition-colors group-hover:bg-slate-300"
              style={{ height: Math.max(2, (d.value / max) * (height - 34)) }}
            />
            {d.secondary !== undefined && d.secondary > 0 && (
              <div
                className="absolute bottom-0 w-full rounded-t bg-emerald-500"
                style={{ height: Math.max(2, (d.secondary / max) * (height - 34)) }}
              />
            )}
            <div className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-white group-hover:block">
              {d.value}
              {d.secondary !== undefined ? ` · ${d.secondary} qual.` : ""}
            </div>
          </div>
          <div className="text-[10px] leading-none text-slate-400">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

export function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2.5 ${align === "right" ? "text-right tabular-nums" : ""} ${className}`}
    >
      {children}
    </td>
  );
}
