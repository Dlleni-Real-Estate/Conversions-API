-- More than one ad account.
--
-- The system was locked to a single account and a single dataset on purpose:
-- a dataset that is NOT connected to the ad account still answers HTTP 200 with
-- events_received: 1, so a wrong pairing looks exactly like success and stays
-- wrong for weeks. That lock was the only thing standing between us and that
-- failure, so it cannot simply be removed -- it has to be replaced by something
-- that checks the same thing at runtime.
--
-- What replaces it: a row here is only ever written after asking Meta which
-- datasets are actually connected to that account (GET /act_<id>/adspixels) and
-- confirming the chosen dataset is among them. The pairing is verified against
-- Meta rather than asserted in code, and `verified_at` records when.

create table if not exists public.ad_accounts (
  ad_account_id   text primary key,          -- bare numeric, no "act_" prefix
  name            text,
  dataset_id      text not null,             -- the dataset CAPI events go to
  dataset_name    text,
  page_id         text,                      -- Page that owns the lead forms
  currency        text,
  enabled         boolean not null default true,
  -- When Meta last confirmed dataset_id is connected to ad_account_id.
  -- Null means never verified: the sync refuses to send for such a row.
  verified_at     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.ad_accounts enable row level security;
-- service_role only, same as every other table here.

drop trigger if exists ad_accounts_touch on public.ad_accounts;
create trigger ad_accounts_touch before update on public.ad_accounts
  for each row execute function public.touch_updated_at();

-- Which account each lead came from. Without it, a lead cannot be routed back
-- to the right dataset, and per-account reporting has nothing to group on.
alter table public.leads add column if not exists ad_account_id text;
create index if not exists leads_ad_account_idx on public.leads (ad_account_id);

-- Same for the two insight tables, so spend can be split by account.
alter table public.campaign_insights add column if not exists ad_account_id text;
alter table public.ad_insights      add column if not exists ad_account_id text;

-- Seed the account that is already live, already verified by the fact that it
-- has been sending accepted events to this dataset for days.
insert into public.ad_accounts (ad_account_id, name, dataset_id, dataset_name, page_id, currency, enabled, verified_at)
values ('736420925136885', 'dlleni ads one', '1718089652564651', 'Dlleni CRM Events', '109652897854140', 'EGP', true, now())
on conflict (ad_account_id) do nothing;

-- Everything stored so far came from that account.
update public.leads set ad_account_id = '736420925136885' where ad_account_id is null;
