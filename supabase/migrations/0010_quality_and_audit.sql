-- Lead quality score (0-100), computed by lib/quality.ts from stage progress,
-- the budget written in the form, contactability, and touch speed. Sent to
-- Meta as event value so optimisation can prefer expensive leads, not just
-- interested ones.
alter table public.leads add column if not exists quality_score integer;

-- Who did what in the dashboard. Written by every mutating endpoint.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       text not null,            -- 'admin' | 'viewer' | 'cron' | 'facebook_login'
  action      text not null,            -- e.g. account_connect, campaign_pin, stage_change
  subject     text,                     -- the id or name acted on
  detail      jsonb,
  ip          text
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
alter table public.audit_log enable row level security;
