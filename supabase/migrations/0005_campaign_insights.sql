-- Meta's own campaign-level numbers, stored verbatim, plus Meta's own
-- cost-per-lead exposed alongside ours on the per-ad view.
--
-- Why: the headline figures used to be summed from the ad-level rows, and that
-- is wrong for two reasons.
--
--   1. REACH IS PEOPLE, NOT EVENTS. The same person can see two ads in the
--      same campaign, so adding each ad's reach counts them twice. Meta
--      deduplicates at campaign level; we cannot reproduce that by adding.
--   2. Meta's ad rows do not always add up to its campaign row — attribution
--      is applied per level.
--
-- Already applied to project yrmgwbufaaiaioqvabon.

create table if not exists public.campaign_insights (
  campaign_id     text primary key,
  campaign_name   text,
  spend           numeric(14,2) not null default 0,
  impressions     bigint        not null default 0,
  reach           bigint        not null default 0,
  frequency       numeric(10,4) not null default 0,
  clicks          bigint        not null default 0,
  link_clicks     bigint        not null default 0,
  ctr             numeric(10,4) not null default 0,
  cpc             numeric(12,4) not null default 0,
  cpm             numeric(12,4) not null default 0,
  meta_leads      bigint        not null default 0,
  cost_per_lead   numeric(12,4),
  currency        text,
  -- The window Meta actually reported on. Its numbers lag by up to a day, so
  -- showing this is the difference between "the dashboard is wrong" and
  -- "Meta has not counted today yet".
  date_start      date,
  date_stop       date,
  updated_at      timestamptz not null default now()
);

alter table public.campaign_insights enable row level security;

-- ad_performance: expose Meta's own cost-per-lead instead of quietly replacing
-- it with ours. They differ, and the difference is informative.
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
  -- Verbatim from Meta
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
  i.cost_per_lead             as meta_cost_per_lead,
  i.currency,
  i.date_start,
  i.date_stop,
  -- From our pipeline
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
