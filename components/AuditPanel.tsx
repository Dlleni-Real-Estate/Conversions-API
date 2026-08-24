"use client";

import { useEffect, useState } from "react";
import { Card, SectionTitle } from "./ui";
import { useLang } from "./LangProvider";

type Entry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  detail: Record<string, unknown> | null;
};

/**
 * The last hundred things anyone did to this system, newest first. Admin-only:
 * the endpoint refuses viewer passwords, and this panel simply stays empty for
 * them rather than pretending there is nothing to see.
 */
export default function AuditPanel({ pw }: { pw: string }) {
  const { t, locale } = useLang();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/audit?limit=100", { headers: { "x-app-password": pw } })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) setEntries(j.entries ?? []);
        else setDenied(true);
      })
      .catch(() => alive && setDenied(true));
    return () => {
      alive = false;
    };
  }, [pw]);

  if (denied || entries === null) return null;

  const label = (action: string): string =>
    (t.auditActions as Record<string, string>)[action] ?? action;

  return (
    <section>
      <SectionTitle title={t.auditTitle} subtitle={t.auditSub} />
      <Card className="overflow-x-auto">
        {entries.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400">{t.auditEmpty}</p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <tbody className="divide-y divide-slate-100">
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-[11px] text-slate-400">
                    {new Date(e.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-2 py-2 text-[11px] font-medium text-slate-500">{e.actor}</td>
                  <td className="px-2 py-2 text-xs font-medium text-slate-800">{label(e.action)}</td>
                  <td className="px-2 py-2 text-[11px] text-slate-500">
                    <span dir="auto" className="ltr-nums">{e.subject || ""}</span>
                    {e.detail && Object.keys(e.detail).length > 0 && (
                      <span className="ms-2 text-slate-400">
                        {Object.entries(e.detail)
                          .filter(([, v]) => v !== null && v !== undefined)
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
