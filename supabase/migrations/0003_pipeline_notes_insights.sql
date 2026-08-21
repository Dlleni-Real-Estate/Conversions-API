-- Sales pipeline, notes timeline, and ad delivery/spend.
-- Already applied to project yrmgwbufaaiaioqvabon.

-- ── 1. The real sales pipeline ─────────────────────────────────────────────
-- Booked and done are separate stages on purpose: the gap between them is the
-- no-show rate, and no-show rate per creative is one of the most honest lead
-- quality signals there is.

alter table public.leads drop constraint if exists leads_status_chk;

update public.leads set status = case status
  when 'meeting' then 'meeting_booked'
  when 'visited' then 'site_visit_done'
  when 'won'     then 'reservation'
  when 'junk'    then 'disqualified'
  when 'lost'    then 'disqualified'
  else status
end
where status in ('meeting','visited','won','junk','lost');

alter table public.leads add constraint leads_status_chk check (status in (
  'new','contacted','no_answer','qualified',
  'meeting_booked','meeting_done','site_visit_booked','site_visit_done',
  'eoi','reservation','disqualified'
));

-- ── 2. Notes timeline ──────────────────────────────────────────────────────
-- Stage moves write themselves in here too, so a lead's history reads as one
-- stream instead of a status plus a separate mystery.

create table if not exists public.lead_notes (
  id          uuid primary key default gen_random_uuid(),
  lead_id     text not null references public.leads(lead_id) on delete cascade,
  kind        text not null default 'note',   -- note | stage
  body        text,
  from_status text,
  to_status   text,
  author      text,
  created_at  timestamptz not null default now(),
  constraint lead_notes_kind_chk check (kind in ('note','stage'))
);

create index if not exists lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);

-- ── 3. Ad spend & delivery ─────────────────────────────────────────────────
create table if not exists public.ad_insights (
  ad_id         text primary key,
  ad_name       text,
  adset_id      text,
  adset_name    text,
  campaign_id   text,
  campaign_name text,
  spend         numeric(14,2) not null default 0,
  impressions   bigint        not null default 0,
  reach         bigint        not null default 0,
  frequency     numeric(10,4) not null default 0,
  clicks        bigint        not null default 0,
  link_clicks   bigint        not null default 0,
  ctr           numeric(10,4) not null default 0,
  cpc           numeric(12,4) not null default 0,
  cpm           numeric(12,4) not null default 0,
  meta_leads    bigint        not null default 0,
  cost_per_lead numeric(12,4),
  currency      text,
  date_start    date,
  date_stop     date,
  updated_at    timestamptz not null default now()
);

create index if not exists ad_insights_campaign_idx on public.ad_insights (campaign_id);

alter table public.lead_notes  enable row level security;
alter table public.ad_insights enable row level security;

-- ── 4. Per-ad view: delivery, money and pipeline in one row ────────────────
drop view if exists public.lead_quality_by_ad;
drop view if exists public.ad_performance;

create view public.ad_performance as
with pipeline as (
  select
    l.ad_id,
    max(l.ad_name)       as ad_name,
    max(l.adset_name)    as adset_name,
    max(l.campaign_id)   as campaign_id,
    max(l.campaign_name) as campaign_name,
    count(*)                                                          as leads,
    count(*) filter (where l.status = 'new')                          as untouched,
    count(*) filter (where l.status <> 'new')                         as worked,
    count(*) filter (where l.status = 'no_answer')                    as no_answer,
    count(*) filter (where l.status in (
      'qualified','meeting_booked','meeting_done','site_visit_booked',
      'site_visit_done','eoi','reservation'))                         as qualified,
    count(*) filter (where l.status in (
      'meeting_booked','meeting_done','site_visit_booked',
      'site_visit_done','eoi','reservation'))                         as meetings_booked,
    count(*) filter (where l.status in (
      'meeting_done','site_visit_booked','site_visit_done','eoi','reservation')) as meetings_done,
    count(*) filter (where l.status in (
      'site_visit_booked','site_visit_done','eoi','reservation'))     as site_visits_booked,
    count(*) filter (where l.status in ('site_visit_done','eoi','reservation'))  as site_visits_done,
    count(*) filter (where l.status in ('eoi','reservation'))         as eoi,
    count(*) filter (where l.status = 'reservation')                  as reservations,
    count(*) filter (where l.status = 'disqualified')                 as disqualified,
    coalesce(sum(l.deal_value) filter (where l.status = 'reservation'), 0) as reservation_value
  from public.leads l
  where l.ad_id is not null
  group by l.ad_id
)
select
  coalesce(p.ad_id, i.ad_id)                 as ad_id,
  coalesce(p.ad_name, i.ad_name)             as ad_name,
  coalesce(p.adset_name, i.adset_name)       as adset_name,
  coalesce(p.campaign_id, i.campaign_id)     as campaign_id,
  coalesce(p.campaign_name, i.campaign_name) as campaign_name,
  coalesce(i.spend, 0)        as spend,
  coalesce(i.reach, 0)        as reach,
  coalesce(i.impressions, 0)  as impressions,
  coalesce(i.frequency, 0)    as frequency,
  coalesce(i.clicks, 0)       as clicks,
  coalesce(i.link_clicks, 0)  as link_clicks,
  coalesce(i.ctr, 0)          as ctr,
  coalesce(i.cpc, 0)          as cpc,
  coalesce(i.cpm, 0)          as cpm,
  coalesce(i.meta_leads, 0)   as meta_leads,
  i.currency,
  coalesce(p.leads, 0)              as leads,
  coalesce(p.untouched, 0)          as untouched,
  coalesce(p.worked, 0)             as worked,
  coalesce(p.no_answer, 0)          as no_answer,
  coalesce(p.qualified, 0)          as qualified,
  coalesce(p.meetings_booked, 0)    as meetings_booked,
  coalesce(p.meetings_done, 0)      as meetings_done,
  coalesce(p.site_visits_booked, 0) as site_visits_booked,
  coalesce(p.site_visits_done, 0)   as site_visits_done,
  coalesce(p.eoi, 0)                as eoi,
  coalesce(p.reservations, 0)       as reservations,
  coalesce(p.disqualified, 0)       as disqualified,
  coalesce(p.reservation_value, 0)  as reservation_value,
  round(100.0 * p.qualified    / nullif(p.leads, 0), 1) as qualified_pct,
  round(100.0 * p.disqualified / nullif(p.leads, 0), 1) as disqualified_pct,
  round(100.0 * (p.meetings_booked - p.meetings_done) / nullif(p.meetings_booked, 0), 1) as no_show_pct,
  round(i.spend / nullif(p.leads, 0), 2)            as cost_per_lead,
  round(i.spend / nullif(p.qualified, 0), 2)        as cost_per_qualified,
  round(i.spend / nullif(p.site_visits_done, 0), 2) as cost_per_site_visit,
  round(i.spend / nullif(p.reservations, 0), 2)     as cost_per_reservation
from pipeline p
full outer join public.ad_insights i on i.ad_id = p.ad_id;
