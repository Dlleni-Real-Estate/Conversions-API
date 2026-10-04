-- An ad account whose leads never go near 8X CRM.
--
-- crm_push (0011) only decides whether leads are SENT to 8X. The mirror that
-- reads stages back still walks every lead and matches by phone, so a lead
-- from an account the CRM never sees could pick up a stage and an owner from
-- some unrelated 8X record of the same number, and be searched for in 8X on
-- every run for a month. crm_sync = false keeps the account out of both
-- directions: its leads are worked in this app, and their stages go to Meta
-- from here.

alter table public.ad_accounts add column if not exists crm_sync boolean not null default true;

comment on column public.ad_accounts.crm_sync is
  'false = this account''s leads are never mirrored from or matched against 8X CRM. Stages are set in this app.';
