-- Returning leads: people who fill a form while already in 8X.
--
-- 8X's duplicate check is on, so a returning person's new form is folded into
-- their old record instead of creating a lead. With "Skip Rotation Change For
-- Cold Calls Data" set to yes, a cold-call record also keeps its old assignee,
-- and nobody is alerted. No new row appears at the top of 8X's list either, so
-- the paged mirror never reaches it; the sync now looks such leads up by phone.

alter table public.leads add column if not exists crm_returning_since timestamptz;
alter table public.leads add column if not exists crm_lookup_at timestamptz;

comment on column public.leads.crm_returning_since is
  'The person was already in 8X since this date; the new form went into that old record, with no new lead and no alert.';
comment on column public.leads.crm_lookup_at is
  'Last time the sync searched 8X for this lead by phone because the paged read did not find it.';

-- Backfill, run once the sync that knows about returning leads is live (the
-- older sync would re-import the old stage on its next pass). A lead whose 8X
-- record is more than a day older than the form is a returning person; the
-- record's age is not this lead's arrival, and a stage set before the form
-- arrived belongs to the old conversation.
update public.leads
set crm_returning_since = crm_created_at, crm_created_at = null
where crm_created_at < submitted_at - interval '1 day' and crm_returning_since is null;

update public.leads
set status = 'new', status_at = null
where crm_returning_since is not null and status <> 'new' and status_at < submitted_at;
