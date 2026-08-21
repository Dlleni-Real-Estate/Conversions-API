# Dlleni — Lead Pipeline & Meta Conversions API

Leads arrive from Meta instant forms → the sales team works them in a dashboard → every stage they set is sent back to Meta through the Conversions API, so the algorithm learns to find people who **buy** rather than people who **fill in forms**.

```
tracked campaigns ──► /api/sync ──► Supabase ──► dashboard ──► /api/feedback ──► CAPI ──► Meta
    every 10 min                     (leads)      (the team)      (the event)     (learns)
```

The sync does **not** sweep the Page's forms. It walks **campaign → ads → leads**, so it only pulls from campaigns you actually care about, and each lead arrives already tagged with its ad, ad set and campaign.

---

## The pipeline

| Stage | Meta event | Meaning |
|---|---|---|
| New | *(none — Meta already fired `Lead`)* | Nobody has touched it |
| Contacted | `Contacted` | Reached them on the phone |
| No answer | `NoAnswer` | Called, nobody picked up |
| **Qualified** | **`Qualified`** | Real budget, real intent |
| Meeting booked | `MeetingBooked` | |
| Meeting done | `MeetingDone` | |
| Site visit booked | `SiteVisitBooked` | |
| Site visit done | `SiteVisitDone` | |
| EOI | `EOI` | Expression of interest signed |
| **Reservation** | **`Reservation`** + value | Money down |
| Disqualified | `Disqualified` | Wrong number, no budget, not interested |

Edit `lib/stages.ts` — one line per stage. The event **name is ours to choose**: whatever string we send becomes a selectable conversion event in Ads Manager. Meta has no fixed list for CRM stages.

"Booked" and "done" are separate on purpose. The gap between them is the **no-show rate**, which is one of the most honest quality signals a creative can be judged on.

---

## Which campaigns are pulled

The rule lives in `lib/tracking.ts` and is one line:

```
tracked = explicit row in tracked_campaigns ?  what that row says
                                            :  campaign created on/after the cutoff date
```

- **A new campaign is pulled automatically.** Nothing to configure, and its forms come along, because the sync walks campaign → ads → leads.
- **Anything older than the cutoff stays out.**
- **Pin a campaign on or off** in Settings to override the rule in either direction; "unpin" returns it to the date rule.

Default cutoff: **1 Aug 2026**. Change it in the Settings tab.

---

## The dashboard

**Pipeline** — the working list. Click a lead to open the side panel: contact details, every form answer, the source ad, the stage picker, and a **timeline** where notes and stage moves live in the same stream. A note typed before picking a stage is attached to that move, so the reason and the move land together.

**Analytics**

- **Money first** — spend, cost per lead, cost per qualified, cost per site visit, cost per reservation
- **Funnel** — each step counts every lead that reached it *or went past it*, with the drop-off from the previous step
- **Ad performance** — reach, impressions, frequency, CTR, CPM alongside leads, qualified %, no-show %, reservations and cost per stage. Sortable on every column.
- **Leads per day** with the qualified share
- **What the form answers predict** — for every repeated answer on the form, how many leads it brought and what share qualified. If an answer does not separate good from bad, that question is not earning its place on the form.
- **Median response time** — how long a lead sits before anyone touches it. In real estate this is the biggest lever the team itself controls.

**Settings** — the cutoff date and the per-campaign switches.

There is no "sync now" button. Leads arrive on their own every 10 minutes; **Refresh** only re-reads what is already stored. Re-syncing can never duplicate a lead or overwrite feedback: `lead_id` is the primary key and inserts run with `ignoreDuplicates`.

---

## Setup

### 1. Environment

| Variable | Value |
|---|---|
| `META_ACCESS_TOKEN` | System User token |
| `META_PAGE_ID` | `109652897854140` — Dlleni |
| `META_DATASET_ID` | `1718089652564651` — **Dlleni CRM Events** (the only one allowed) |
| `META_AD_ACCOUNT_ID` | `736420925136885` — dlleni ads one (the only one allowed) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → Settings → API |
| `APP_PASSWORD` | what the team types to sign in |
| `CRON_SECRET` | random string; sent on cron calls |
| `META_TEST_EVENT_CODE` | **testing only** — remove in production |

> Token scopes: `leads_retrieval` · `pages_show_list` · `pages_manage_ads` · `ads_management` · `ads_read` · `business_management`

### 2. Database

Migrations in `supabase/migrations/` are already applied to project `Conversions-API`.

### 3. Run

```bash
npm install
npm run dev      # http://localhost:3000
```

Scheduling lives in Supabase `pg_cron` (Vercel Hobby only allows daily crons):

- `/api/sync` every 10 minutes
- `/api/capi/replay` hourly

---

## Turning on Conversion Leads

Meta needs volume before the optimisation is worth switching on — roughly **250 leads/month**, with the chosen stage happening **within 28 days** of the lead and converting at **between 1% and 40%**. That last one matters most in practice: if `Qualified` comes out at 60% of all leads it separates nothing, and you should optimise for a deeper stage such as *Site visit done*.

When you are there: **Ads Manager → Ad set → Performance goal → Maximise number of conversion leads → Dataset: Dlleni CRM Events → Conversion event:** pick one of the names above. An event only appears in that dropdown once it has actually reached the dataset, which is why the team should start setting stages now.

> Also build a **Lookalike from the leads that reserved**, not from all leads. That is the strongest audience this data will ever produce.

---

## Things that are handled, and why

**1. Page token.** `/{page-id}/leadgen_forms` and `/{form-id}/leads` **reject** a System User token with `(#190) This method must be called with a Page Access Token`. `lib/meta.ts` exchanges for a Page token and caches it.

**2. `lead_id` is not hashed.** It is Meta's own identifier — SHA-256 it and nothing matches. Only phone and email are hashed.

**3. Dedup.** Every event carries `event_id = "{lead_id}:{event_name}"`, so replays and double-clicks cannot inflate the numbers.

**4. No event is lost.** The event is written to `capi_events` **before** it is sent. If the network drops, the hourly cron retries it (6 attempts).

**5. Syncing never wipes feedback.** `ignoreDuplicates` — an existing lead is left untouched, so the team's work survives every re-sync.

**6. Egyptian numbers.** `01xxxxxxxxx`, `+20`, `002` all normalise to `20xxxxxxxxxx` before hashing, which is what raises Event Match Quality.

**7. Scope lock.** `lib/meta.ts` refuses to start against any dataset other than `1718089652564651` or any ad account other than `736420925136885`. A dataset that is not connected to the ad account still answers `200` with `events_received: 1` — a wrong id looks exactly like success, so it has to fail loudly instead.

**8. Campaign-scoped, not form-scoped.** A form is not owned by a campaign — the same form can run under several — so filtering by form gives a dirty result. Walking campaign → ads → `/{ad-id}/leads` also hands us the campaign and ad names for free, so they are right even when Meta omits them from the lead object.

**9. The CRM contract.** `action_source: "system_generated"`, raw `user_data.lead_id`, `custom_data.lead_event_source` and `custom_data.event_source: "crm"` must all be present on **every** event. Without them Meta accepts the event (`200`, `events_received: 1`) but treats it as a plain custom event that never feeds Conversion Leads.

---

## Files

```
app/
  page.tsx                  shell + tabs
  api/sync/                 pull leads + refresh ad spend
  api/campaigns/            read/change tracked campaigns
  api/leads/                lead list
  api/analytics/            KPIs, funnel, ad table, segments
  api/feedback/             stage change → timeline → CAPI
  api/notes/                lead notes timeline
  api/capi/replay/          retry failed events
components/
  LeadsView.tsx             the working list
  LeadPanel.tsx             one lead: details, stages, timeline
  AnalyticsView.tsx         the analysis screen
  CampaignSettings.tsx      cutoff date + per-campaign switches
  ui.tsx                    shared primitives and formatters
lib/
  meta.ts                   Graph API, page token, campaigns, insights
  tracking.ts               which campaigns are tracked
  capi.ts                   build and send events
  stages.ts                 the pipeline — edit here
  supabase.ts / auth.ts
supabase/migrations/        schema
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/sync` | pull from tracked campaigns · `?full=1` re-reads everything |
| `GET /api/leads` | `?status=` `?campaign=` `?ad=` `?q=` |
| `GET /api/analytics` | `?campaign=` |
| `GET /api/campaigns` | all campaigns + tracked state |
| `POST /api/campaigns` | `{cutoff}` or `{campaign_id, enabled}` (`null` = unpin) |
| `POST /api/feedback` | `{lead_id, status, note?, deal_value?}` |
| `GET/POST /api/notes` | `?lead_id=` · `{lead_id, body}` |
| `GET /api/capi/replay` | retry failed events |

Everything is behind `x-app-password` or `Authorization: Bearer $CRON_SECRET`.
