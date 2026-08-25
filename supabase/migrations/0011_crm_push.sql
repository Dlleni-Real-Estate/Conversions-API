-- One ad account's leads never reach 8X CRM on their own: the CRM's Facebook
-- integration is connected to the original page only, so a second Business's
-- leads sit here with nobody assigned to call them. This is the bookkeeping
-- for pushing them across.
--
-- crm_push is opt-in per account and false by default, and that default is the
-- point. The original account's leads DO arrive in 8X by themselves; pushing
-- those would create a second copy of every lead, and two agents calling the
-- same person is worse than the problem being solved.

alter table ad_accounts add column if not exists crm_push boolean not null default false;

alter table leads add column if not exists crm_pushed_at timestamptz;
alter table leads add column if not exists crm_push_error text;

comment on column ad_accounts.crm_push is
  'Push this account''s leads into 8X CRM. Leave false for accounts the CRM already receives through its own Facebook integration.';
comment on column leads.crm_pushed_at is
  'When 8X CRM accepted this lead from us. NULL means it is still queued.';

-- The queue query: leads of an opted-in account that have not gone yet.
create index if not exists leads_crm_queue_idx
  on leads (ad_account_id, submitted_at)
  where crm_pushed_at is null;

-- AR Elite Propertis: verified above as absent from the CRM (searching one of
-- its lead phone numbers returns nothing), so it is the account that opts in.
update ad_accounts set crm_push = true where ad_account_id = '1567088381488610';
