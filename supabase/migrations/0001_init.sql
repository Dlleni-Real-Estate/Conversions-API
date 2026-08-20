-- Dlleni — Meta Lead Ads → Dashboard → Conversions API feedback loop
-- Everything hangs off Meta's leadgen id (lead_id). That is the join key CAPI
-- uses to tell Meta "this specific lead turned out good/bad".

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- leads
-- ─────────────────────────────────────────────────────────────
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),

  -- Meta identity
  lead_id         text not null unique,          -- 15-17 digit Meta leadgen id
  form_id         text,
  form_name       text,
  page_id         text,
  ad_id           text,
  ad_name         text,
  adset_id        text,
  adset_name      text,
  campaign_id     text,
  campaign_name   text,
  platform        text,                          -- fb | ig
  is_organic      boolean default false,
  submitted_at    timestamptz not null,          -- Meta created_time

  -- contact (from the instant form answers)
  full_name       text,
  phone           text,
  email           text,
  raw_fields      jsonb not null default '{}'::jsonb,

  -- feedback from the sales team
  status          text not null default 'new',
  notes           text,
  owner           text,
  deal_value      numeric(14,2),                 -- commission/deal value on won
  status_at       timestamptz,

  synced_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint leads_status_chk check (status in (
    'new','contacted','qualified','meeting','visited','won','junk','lost'
  ))
);

create index if not exists leads_submitted_at_idx  on public.leads (submitted_at desc);
create index if not exists leads_status_idx        on public.leads (status);
create index if not exists leads_campaign_idx      on public.leads (campaign_id);
create index if not exists leads_ad_idx            on public.leads (ad_id);
create index if not exists leads_form_idx          on public.leads (form_id);
create index if not exists leads_phone_idx         on public.leads (phone);

-- ─────────────────────────────────────────────────────────────
-- capi_events — an audit log of everything pushed back to Meta
-- ─────────────────────────────────────────────────────────────
create table if not exists public.capi_events (
  id            uuid primary key default gen_random_uuid(),
  lead_id       text not null,
  event_name    text not null,
  event_id      text not null unique,   -- our dedup key, also sent to Meta
  event_time    timestamptz not null,
  payload       jsonb not null,
  response      jsonb,
  status        text not null default 'pending',  -- pending | sent | failed
  attempts      int  not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,

  constraint capi_status_chk check (status in ('pending','sent','failed'))
);

create index if not exists capi_status_idx  on public.capi_events (status);
create index if not exists capi_lead_idx    on public.capi_events (lead_id);

-- ─────────────────────────────────────────────────────────────
-- sync_runs — so a silent cron failure is visible
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sync_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  forms_seen   int default 0,
  leads_found  int default 0,
  leads_new    int default 0,
  ok           boolean,
  error        text
);

-- ─────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Reporting: quality by ad. This is the whole point — CPL is not
-- the question, cost per *qualified* lead per creative is.
-- ─────────────────────────────────────────────────────────────
create or replace view public.lead_quality_by_ad as
select
  campaign_name,
  adset_name,
  ad_name,
  ad_id,
  count(*)                                             as leads,
  count(*) filter (where status = 'junk')              as junk,
  count(*) filter (where status in ('qualified','meeting','visited','won')) as qualified,
  count(*) filter (where status = 'meeting')           as meetings,
  count(*) filter (where status = 'won')               as won,
  coalesce(sum(deal_value) filter (where status = 'won'), 0) as won_value,
  round(
    100.0 * count(*) filter (where status in ('qualified','meeting','visited','won'))
    / nullif(count(*), 0)
  , 1)                                                 as qualified_pct,
  round(100.0 * count(*) filter (where status = 'junk') / nullif(count(*), 0), 1) as junk_pct
from public.leads
group by campaign_name, adset_name, ad_name, ad_id
order by leads desc;

-- ─────────────────────────────────────────────────────────────
-- RLS: locked by default. The app talks to Postgres with the
-- service-role key from server-side code only, which bypasses RLS.
-- No policy is granted to anon/authenticated on purpose — if you
-- later add Supabase Auth for brokers, add scoped policies here.
-- ─────────────────────────────────────────────────────────────
alter table public.leads       enable row level security;
alter table public.capi_events enable row level security;
alter table public.sync_runs   enable row level security;
