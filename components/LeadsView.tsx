"use client";

import { useMemo } from "react";
import { STAGES, STAGE_BY_STATUS, type Status } from "@/lib/stages";
import { Badge, Card, Empty, Td, Th, fmtAgo, fmtDate } from "./ui";
import type { Lead } from "./types";

/**
 * The working list. One row per lead, ordered newest first, with just enough on
 * the row to decide who to call next — and the whole story one click away.
 */
export default function LeadsView({
  leads,
  loading,
  statusFilter,
  onStatusFilter,
  search,
  onSearch,
  onOpen,
  selectedId,
}: {
  leads: Lead[];
  loading: boolean;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  onOpen: (lead: Lead) => void;
  selectedId: string | null;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: leads.length };
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

  return (
    <Card
      title="Leads"
      subtitle={`${leads.length} shown${statusFilter !== "all" ? " · filtered" : ""}`}
      right={
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="all">All statuses</option>
            <option value="open">Open — still worth a call</option>
            {STAGES.map((s) => (
              <option key={s.status} value={s.status}>
                {s.label}
                {counts[s.status] ? ` (${counts[s.status]})` : ""}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Name or phone…"
            className="w-48 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-slate-900"
          />
        </div>
      }
    >
      {leads.length === 0 ? (
        <Empty>{loading ? "Loading…" : "No leads match this view."}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50/60">
              <tr>
                <Th>Lead</Th>
                <Th>Source</Th>
                <Th>Submitted</Th>
                <Th>Status</Th>
                <Th>Last note</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {leads.map((lead) => {
                const stage = STAGE_BY_STATUS[lead.status];
                const stale = lead.status === "new";
                return (
                  <tr
                    key={lead.lead_id}
                    onClick={() => onOpen(lead)}
                    className={`cursor-pointer transition ${
                      selectedId === lead.lead_id ? "bg-slate-100" : "hover:bg-slate-50/70"
                    }`}
                  >
                    <Td>
                      <div className="flex items-center gap-2">
                        {stale && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" title="Untouched" />}
                        <span className="font-medium text-slate-900">{lead.full_name || "Unnamed"}</span>
                      </div>
                      {lead.phone && <div className="text-xs text-slate-500">{lead.phone}</div>}
                    </Td>
                    <Td>
                      <div className="text-xs font-medium text-slate-700">{lead.ad_name || "—"}</div>
                      <div className="text-xs text-slate-400">{lead.form_name || lead.campaign_name || ""}</div>
                    </Td>
                    <Td>
                      <div className="text-xs text-slate-600">{fmtDate(lead.submitted_at)}</div>
                      <div className="text-xs text-slate-400">{fmtAgo(lead.submitted_at)}</div>
                    </Td>
                    <Td>
                      <Badge className={stage.color}>{stage.label}</Badge>
                    </Td>
                    <Td>
                      <div className="max-w-xs truncate text-xs text-slate-500">{lead.notes || "—"}</div>
                      {(lead.note_count ?? 0) > 0 && (
                        <div className="text-[11px] text-slate-400">{lead.note_count} notes</div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export type { Status };
