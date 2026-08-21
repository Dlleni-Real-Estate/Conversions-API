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
| New | **`RawLead`** — sent on sync for every lead | Nobody has touched it. Meta needs this as the funnel's base |
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

**Pipeline** — the working list. Change a lead's stage from a coloured dropdown **on the row itself**, and add a note from the row too: the two things a broker does a hundred times a day never cost a click into a panel. Open a lead when you want the whole story — contact details, every form answer in the form's own wording, the source ad, and a **timeline** where notes and stage moves live in the same stream. A note typed before picking a stage is attached to that move, so the reason and the move land together.

**Analytics**

- **Reported by Meta** — spend, reach, impressions, frequency, clicks, CTR, CPM, CPC, Meta's own lead count and cost per lead, **verbatim**, with the window Meta has actually counted. Nothing in this block is derived from our lead table, and **reach is never added across campaigns** — it counts people, and Meta deduplicates it only within a campaign, so with more than one campaign in scope it shows `—` rather than a number that looks right and is not.
- **Your pipeline** — the same spend, divided by *our* counts: cost per lead, per qualified, per site visit, per reservation. Our lead count is exact and immediate; Meta's lags a day and applies attribution windows. They are shown side by side rather than blended.
- **Funnel** — each step counts every lead that reached it *or went past it*, with the drop-off from the previous step
- **Ad performance** — reach, impressions, frequency, CTR, CPM alongside leads, qualified %, no-show %, reservations and cost per stage. Sortable on every column.
- **Leads per day** with the qualified share
- **What the form answers predict** — for every repeated answer on the form, how many leads it brought and what share qualified. If an answer does not separate good from bad, that question is not earning its place on the form.
- **Median response time** — how long a lead sits before anyone touches it. In real estate this is the biggest lever the team itself controls.

**Settings** — the cutoff date and the per-campaign switches.

**Language** — an EN / ع switch in the header flips the whole interface, including direction. It changes the *chrome* only: headings, buttons, column names. Lead data is never translated — see below.

There is no "sync now" button. Leads arrive on their own every 10 minutes; **Refresh** only re-reads what is already stored. Re-syncing can never duplicate a lead or overwrite feedback: `lead_id` is the primary key and inserts run with `ignoreDuplicates`.

---

## The form is shown in its own words

Meta's lead payload is machine keys, not the text the customer read:

```
{ "payment_method": "still_exploring" }        ← what Meta sends
  "تحب تدفع إزاي؟"  →  "لسه بستكشف وبسأل"        ← what the customer actually saw
```

The wording lives only on the form definition, so the sync stores each form's schema in `lead_forms` and `lib/labels.ts` looks the wording back up for display. **Nothing is translated** — an Arabic form shows Arabic, in the exact words it was written in, whichever interface language is selected.

`raw_fields` deliberately keeps the keys. Keys are stable, so analytics can group by them even after the Arabic wording is edited.

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

## Turning on qualified leads

Meta renamed this. In Ads Manager it is now **Maximize number of qualified leads**, reached at the ad set level: **Conversions → Leads dropdown → Qualified leads**. Older writing (including earlier versions of this file) calls it "conversion leads".

**This integration is what keeps the goal available.** Meta's own page states it plainly: from **April 2026** the qualified-leads goal is not available for new campaign creation without a Conversions API integration, and **existing campaigns are impacted beginning August 2026**. The CRM feed is no longer an optimisation on top — it is the entry ticket.

### How much volume is actually required

Meta states this in its **developer** documentation (the Business Help Centre does not repeat it, which is what makes it easy to get wrong). Under *Check if your business is a good fit*:

- **Generate at least 200 leads per month**
- Upload data **at least once per day** — this app syncs every 10 minutes
- The stage you optimise for **occurs within 28 days** of the lead
- The stage you optimise for has a **conversion rate between 1% and 40%**

The 1%–40% rule is the one that bites: it is measured against the raw-lead stage, so if `Qualified` comes out at 60% of leads it separates nothing and the goal will not train on it. The **Qual. %** column in Analytics is what tells you.

Meta's own project timeline for this integration: ~1–2 days data validation, then a **2–4 week learning period** before the full performance lift shows. Total time to value ~3–4 weeks.

### Configuring the sales funnel

Meta does **not** have a fixed list of lead statuses that ours must map onto. Its in-account CRM guide defines the field as *"`event_name` — The name of a critical stage in your CRM that a lead is changing to"*: the name is ours. What Meta does have is two buckets, arranged by hand in Events Manager under *Configure your sales funnel*:

- **Positive stages** — *"Events that signify a quality lead"*. You order them yourself; that order is the funnel Meta trains on. Ours, in order: `RawLead → Contacted → Qualified → MeetingBooked → MeetingDone → SiteVisitBooked → SiteVisitDone → EOI → Reservation`.
- **Other stages** — *"Events that do not signify a quality lead, for example, test events or events accidentally uploaded from another system."* Ours should stay empty.

`NoAnswer` and `Disqualified` belong in **neither**. Meta: *"Remove events that indicate a negative lead or do not belong in your sales funnel by clicking the minus (-) button next to each event. These could be leads that received a phone call, but decided to not convert into a sale."* We keep sending them — they are useful in our own reporting and for future exclusion audiences — but they must be removed from the funnel screen.

### Choosing the event

An event only appears in the dropdown once it has actually reached the dataset, which is why the team should start setting stages now.

Pick the **earliest** stage that genuinely separates, not the deepest. Meta: *"select the earliest lead stage to optimize for. The selected lead stage does not need to be the last stage of the funnel. **The system optimizes for all down-funnel stages as well.**"* Choosing `Qualified` therefore also pulls for `MeetingDone`, `SiteVisitDone`, `EOI` and `Reservation` — there is no trade-off to make.

The one reason to go deeper is the 1%–40% rule: if `Qualified` turns out to be most of your leads it discriminates nothing, and `SiteVisitDone` becomes the target instead. The **Qual. %** column in Analytics is what tells you which.

Meta may also override the choice on its own: *"The system may adjust and optimize for a different lead stage than the one you selected as the optimization target if better performance can be achieved."*

The funnel screen only unlocks after Meta validates the feed — its guide ends with *"Once your integration is working, Meta will validate the data"*, which takes roughly a day of daily uploads.

> Also build a **Lookalike from the leads that reserved**, not from all leads. That is the strongest audience this data will ever produce.

---

## Things that are handled, and why

**1. Page token.** `/{page-id}/leadgen_forms` and `/{form-id}/leads` **reject** a System User token with `(#190) This method must be called with a Page Access Token`. `lib/meta.ts` exchanges for a Page token and caches it.

**2. `lead_id` is not hashed, and it is a number.** It is Meta's own identifier — SHA-256 it and nothing matches. Only phone and email are hashed.

Meta types the field as **integer**, and a JSON *string* is accepted with no error and then matched against nothing: every event reads `Active` in Events Manager while the CRM report shows **Lead coverage 0%** and an empty funnel. Because a lead id is 15–17 digits it also passes JavaScript's safe-integer ceiling, so `Number()` would silently round the last digits off it (`39695357398433621` → `...624`). `lib/capi.ts` therefore carries the id as a string everywhere and un-quotes it in the serialised body.

**Lead coverage must be at least 60%** for conversion-leads optimisation to run at all — Meta states this on the CRM diagnostic report in Events Manager. That is the percentage of its leads that received a matching event from us, which is why every lead gets `RawLead` whether or not anyone touched it.

**3. Dedup.** Every event carries `event_id = "{lead_id}:{event_name}:{version}"`, so replays and double-clicks cannot inflate the numbers. The version is bumped only when a change makes already-sent events *wrong* rather than missing — Meta drops a repeat of an `event_id` it has seen, so a correction has to arrive under a new id or it is ignored.

**3b. A skipped stage is a lost stage.** Meta counts a lead as having reached a stage only if we sent that stage's event. A broker who drags a lead straight from New to *Site visit done* would leave Meta believing it was never qualified — and `Qualified` is what the campaign optimises for. `/api/feedback` therefore sends every positive stage from 1 up to the one chosen, with ordered timestamps. Meta asks for this directly on the CRM card: *"For best results, send all existing events."*

**4. No event is lost.** The event is written to `capi_events` **before** it is sent. If the network drops, the hourly cron retries it (6 attempts).

**5. Syncing never wipes feedback.** `ignoreDuplicates` — an existing lead is left untouched, so the team's work survives every re-sync.

**6. Egyptian numbers.** `01xxxxxxxxx`, `+20`, `002` all normalise to `20xxxxxxxxxx` before hashing, which is what raises Event Match Quality.

**7. Scope lock.** `lib/meta.ts` refuses to start against any dataset other than `1718089652564651` or any ad account other than `736420925136885`. A dataset that is not connected to the ad account still answers `200` with `events_received: 1` — a wrong id looks exactly like success, so it has to fail loudly instead.

**8. Campaign-scoped, not form-scoped.** A form is not owned by a campaign — the same form can run under several — so filtering by form gives a dirty result. Walking campaign → ads → `/{ad-id}/leads` also hands us the campaign and ad names for free, so they are right even when Meta omits them from the lead object.

**9. The CRM contract.** `action_source: "system_generated"`, raw `user_data.lead_id`, `custom_data.lead_event_source` and `custom_data.event_source: "crm"` must all be present on **every** event. Without them Meta accepts the event (`200`, `events_received: 1`) but treats it as a plain custom event that never feeds the qualified-leads optimisation.

**10. The raw-lead stage — the easiest thing to get wrong.** Meta fires its own `Lead` event when the form is submitted, and it is tempting to conclude the CRM does not need to report the lead again. It does. Meta's spec: *"If your campaigns generate 100 leads, then Meta expects 100 'Raw Lead' events uploaded to represent the first lead stage."* It is the **denominator** — the conversion rate of every stage above it, and therefore the 1%–40% eligibility rule, is measured against it. This app sends it as `RawLead` on sync (named so it cannot be confused with Meta's own `Lead` in Events Manager), as a self-healing sweep over the last 7 days — Meta's backfill limit, and it discards events timestamped before the lead existed.

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
  LangProvider.tsx          EN/AR switch, direction, stage names
  LeadsView.tsx             the working list — inline stage + inline notes
  LeadPanel.tsx             one lead: details, stages, timeline
  AnalyticsView.tsx         the analysis screen
  CampaignSettings.tsx      cutoff date + per-campaign switches
  ui.tsx                    shared primitives and formatters
lib/
  meta.ts                   Graph API, page token, campaigns, insights, form schemas
  i18n.ts                   interface strings — chrome only, never data
  labels.ts                 Meta's keys → the form's own wording
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
