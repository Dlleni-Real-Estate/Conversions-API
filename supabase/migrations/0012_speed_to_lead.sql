-- Speed to lead: how long each lead waited, and whose wait it was.
--
-- Two clocks per lead, so nobody answers for somebody else's delay:
--   routing  from the lead landing in 8X to the team leader handing it to an agent
--   pickup   from the agent receiving it to that agent's first action on it
-- If the team leader works the lead herself before handing it on, the first
-- action is hers and so is the credit.
--
-- The raw material is what 8X shows on every sync: who holds the lead and since
-- when (assignees[].created_at), and the latest activity with its real author
-- and time (last_activity). 8X exposes no readable history, so the two tables
-- below ARE that history, accumulated one sync at a time.

alter table public.leads add column if not exists crm_created_at timestamptz;
comment on column public.leads.crm_created_at is
  'When the lead appeared in 8X CRM (its own created_at). The routing clock starts here.';

-- Every (lead, assignee, since-when) the sync has ever seen. An assignee who is
-- later removed stays on record, which is what makes a hand-off measurable.
create table if not exists public.lead_assignments (
  lead_id       text        not null references public.leads(lead_id) on delete cascade,
  user_id       integer     not null,
  user_name     text,
  assigned_at   timestamptz not null,
  first_seen_at timestamptz not null default now(),
  primary key (lead_id, user_id, assigned_at)
);

-- Every action the sync has seen on a lead: an activity (call, note, anything
-- logged in 8X, text or not) or a stage move. actor '' means not known - the
-- stage moves recorded before this table existed carry no author.
create table if not exists public.lead_activities (
  lead_id       text        not null references public.leads(lead_id) on delete cascade,
  kind          text        not null,
  at            timestamptz not null,
  actor         text        not null default '',
  actor_id      integer,
  has_note      boolean     not null default false,
  to_status     text,
  -- true = `at` is when the sync NOTICED the action, not when it happened.
  -- Only the backfilled stage moves below; everything new carries 8X's own time.
  approx        boolean     not null default false,
  first_seen_at timestamptz not null default now(),
  constraint lead_activities_kind_chk check (kind in ('activity', 'stage')),
  primary key (lead_id, kind, at, actor)
);

create index if not exists lead_activities_lead_idx on public.lead_activities (lead_id, at);
create index if not exists lead_assignments_lead_idx on public.lead_assignments (lead_id, assigned_at);

alter table public.lead_assignments enable row level security;
alter table public.lead_activities  enable row level security;

-- User 14 was "Agent #14" until the name was read off an 8X timeline.
update public.leads      set owner  = replace(owner, 'Agent #14', 'Hanaa Sayd') where owner like '%Agent #14%';
update public.lead_notes set author = 'Hanaa Sayd' where author = 'Agent #14';

-- Backfill from what is already mirrored.
-- Notes carry 8X's real time and real author.
insert into public.lead_activities (lead_id, kind, at, actor, has_note)
select lead_id, 'activity', created_at, coalesce(author, ''), true
from public.lead_notes
where kind = 'note'
on conflict do nothing;

-- Stage moves carry only the time the sync noticed them, hence approx.
insert into public.lead_activities (lead_id, kind, at, actor, to_status, approx)
select lead_id, 'stage', created_at, '', to_status, true
from public.lead_notes
where kind = 'stage'
on conflict do nothing;

-- The move into the lead's CURRENT stage has a better time than that: status_at
-- is 8X's own updated_at, read on the run that noticed the move. It can only be
-- earlier than the moment of noticing, so take whichever came first.
with latest as (
  select distinct on (a.lead_id) a.lead_id, a.at
  from public.lead_activities a
  join public.leads l on l.lead_id = a.lead_id
  where a.kind = 'stage' and a.to_status = l.status
  order by a.lead_id, a.at desc
)
update public.lead_activities a
set at = l.status_at, approx = false
from latest, public.leads l
where a.lead_id = latest.lead_id and a.at = latest.at and a.kind = 'stage' and a.actor = ''
  and l.lead_id = a.lead_id and l.status_at is not null and l.status_at < a.at
  and not exists (
    select 1 from public.lead_activities x
    where x.lead_id = a.lead_id and x.kind = 'stage' and x.actor = '' and x.at = l.status_at
  );

-- One round trip for a whole run's arrival times, instead of an UPDATE per
-- lead: the first run after this ships stamps a few hundred at once, and the
-- sync shares a 60-second budget with everything else it does.
create or replace function public.mirror_crm_created_at(rows jsonb)
returns integer
language sql
security invoker
set search_path = public
as $$
  with src as (
    select e->>'lead_id' as lead_id, (e->>'at')::timestamptz as at
    from jsonb_array_elements(rows) e
  ), changed as (
    update public.leads l
    set crm_created_at = src.at
    from src
    where l.lead_id = src.lead_id and l.crm_created_at is distinct from src.at
    returning 1
  )
  select count(*)::integer from changed;
$$;

revoke all on function public.mirror_crm_created_at(jsonb) from public, anon, authenticated;
grant execute on function public.mirror_crm_created_at(jsonb) to service_role;
