-- Which campaigns feed the dashboard.
--
-- Rule: a campaign is tracked when it was created on/after `campaign_cutoff`,
-- UNLESS there is an explicit row in tracked_campaigns, which wins in either
-- direction. That way a brand-new campaign is picked up with no action at all,
-- while every campaign older than the cutoff stays out.
--
-- Already applied to project yrmgwbufaaiaioqvabon.

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.tracked_campaigns (
  campaign_id            text primary key,
  campaign_name          text,
  enabled                boolean not null default true,
  campaign_created_time  timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.app_settings      enable row level security;
alter table public.tracked_campaigns enable row level security;

-- No policies: service_role only, same as leads/capi_events/sync_runs.

create index if not exists leads_campaign_submitted_idx
  on public.leads (campaign_id, submitted_at desc);

insert into public.app_settings (key, value)
values ('campaign_cutoff', jsonb_build_object('since', '2026-08-01T00:00:00Z'))
on conflict (key) do nothing;
