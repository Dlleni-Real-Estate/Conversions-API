"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SectionTitle } from "./ui";
import { useLang } from "./LangProvider";

type Connected = {
  ad_account_id: string;
  name: string | null;
  dataset_id: string;
  dataset_name: string | null;
  page_id: string | null;
  enabled: boolean;
  verified_at: string | null;
  last_error: string | null;
};
type Available = { id: string; name?: string; currency?: string; status?: number };
type Ref = { id: string; name?: string };
type Payload = {
  ok: boolean;
  connected: Connected[];
  available: Available[];
  datasets: Record<string, Ref[]>;
  pages: Record<string, Ref[]>;
  pageSource: Record<string, "account" | "user" | "none">;
  envPageId: string | null;
  listError: string | null;
};

/**
 * Connect and disconnect ad accounts.
 *
 * The picker only ever offers dataset/account pairs Meta reports as connected,
 * and an account Meta reports no dataset for is shown as blocked with the fix
 * spelled out. That is deliberate: a wrong pairing is accepted by Meta with a
 * 200 and attributed to nothing, so it cannot be caught later — it has to be
 * made unpickable here.
 */
export default function AdAccounts({ pw }: { pw: string }) {
  const { t, locale } = useLang();
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [pickedPage, setPickedPage] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ad-accounts", { headers: { "x-app-password": pw } });
      const j = await r.json();
      if (j.ok) { setData(j); setErr(null); } else setErr(j.error || "Error");
    } catch { setErr(t.connectionError); }
  }, [pw, t]);

  useEffect(() => { load(); }, [load]);

  const call = async (method: "POST" | "DELETE", body?: unknown, qs = "") => {
    setBusy(String((body as { ad_account_id?: string })?.ad_account_id ?? qs));
    setErr(null);
    try {
      const r = await fetch(`/api/ad-accounts${qs}`, {
        method,
        headers: { "x-app-password": pw, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const j = await r.json();
      if (!j.ok) setErr(j.error || "Error");
      await load();
    } catch { setErr(t.connectionError); } finally { setBusy(null); }
  };

  if (!data) return null;

  const connectedIds = new Set(data.connected.map((c) => c.ad_account_id));
  const notConnected = data.available.filter((a) => !connectedIds.has(a.id));

  return (
    <section>
      <SectionTitle title={t.accountsTitle} subtitle={t.accountsSub} />

      {err && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-700">{err}</p>
      )}
      {data.listError && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {t.accountsListFail}: {data.listError}
        </p>
      )}

      <div className="space-y-3">
        {data.connected.map((c) => (
          <Card key={c.ad_account_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p dir="auto" className="truncate font-medium text-slate-800">
                {c.name || c.ad_account_id}
                {!c.verified_at && (
                  <span className="ms-2 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                    {t.accUnverified}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                <span className="ltr-nums">{c.ad_account_id}</span> · {t.accDataset}:{" "}
                {c.dataset_name || c.dataset_id}
                {c.page_id && <> · {t.accPage}: <span className="ltr-nums">{c.page_id}</span></>}
                {c.verified_at && (
                  <> · {t.accVerified} {new Date(c.verified_at).toLocaleDateString(locale)}</>
                )}
              </p>
              {c.last_error && <p className="mt-1 text-[11px] text-red-600">{c.last_error}</p>}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => call("POST", { ad_account_id: c.ad_account_id, enabled: !c.enabled })}
                disabled={busy === c.ad_account_id}
                className={`tap rounded-lg border px-3 py-1.5 text-xs font-medium shadow-card disabled:opacity-40 ${
                  c.enabled
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-slate-300 bg-white text-slate-500"
                }`}
              >
                {c.enabled ? t.accOn : t.accOff}
              </button>
              <button
                onClick={() => call("DELETE", undefined, `?ad_account_id=${c.ad_account_id}`)}
                disabled={busy === `?ad_account_id=${c.ad_account_id}`}
                className="tap rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 shadow-card hover:bg-red-50 disabled:opacity-40"
              >
                {t.accDisconnect}
              </button>
            </div>
          </Card>
        ))}
      </div>

      {notConnected.length > 0 && (
        <>
          <p className="mb-2 mt-5 text-xs font-medium text-slate-500">{t.accAddTitle}</p>
          <div className="space-y-3">
            {notConnected.map((a) => {
              const sets = data.datasets[a.id] ?? [];
              const pages = data.pages?.[a.id] ?? [];
              const src = data.pageSource?.[a.id] ?? "none";
              const blocked = sets.length === 0;
              const chosen = picked[a.id] ?? sets[0]?.id ?? "";
              // When Meta named no Page for this account these are just the
              // Pages the token can see, so the one already in use is the
              // sensible default rather than whatever came back first.
              const fallbackPage =
                (src === "user" && data.envPageId && pages.some((p) => p.id === data.envPageId)
                  ? data.envPageId
                  : pages[0]?.id) ?? "";
              const chosenPage = pickedPage[a.id] ?? fallbackPage;
              return (
                <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p dir="auto" className="truncate font-medium text-slate-800">{a.name || a.id}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      <span className="ltr-nums">{a.id}</span>
                      {a.currency ? ` · ${a.currency}` : ""}
                    </p>
                    {blocked && (
                      <p className="mt-1.5 max-w-xl rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
                        {t.accNoDataset}
                      </p>
                    )}
                    {!blocked && src === "user" && (
                      <p className="mt-1.5 max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
                        {t.accPageUnassigned}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {sets.length > 1 && (
                      <select
                        value={chosen}
                        onChange={(e) => setPicked((p) => ({ ...p, [a.id]: e.target.value }))}
                        aria-label={t.accDataset}
                        className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
                      >
                        {sets.map((d) => (
                          <option key={d.id} value={d.id}>{d.name || d.id}</option>
                        ))}
                      </select>
                    )}
                    {pages.length > 1 && (
                      <select
                        value={chosenPage}
                        onChange={(e) => setPickedPage((p) => ({ ...p, [a.id]: e.target.value }))}
                        aria-label={t.accPage}
                        className="tap rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs shadow-card"
                      >
                        {pages.map((d) => (
                          <option key={d.id} value={d.id}>{d.name || d.id}</option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() =>
                        call("POST", {
                          ad_account_id: a.id,
                          dataset_id: chosen,
                          name: a.name,
                          ...(chosenPage ? { page_id: chosenPage } : {}),
                        })
                      }
                      disabled={blocked || busy === a.id}
                      className="tap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-card hover:bg-brand-700 disabled:opacity-40"
                    >
                      {busy === a.id ? t.accConnecting : t.accConnect}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
