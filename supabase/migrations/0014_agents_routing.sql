-- Agents who work leads inside this app (the Android agent app), and the rules
-- that hand them leads.
--
-- Until now nobody typed a stage into this app: the team worked in 8X and the
-- sync mirrored what they did. Routed campaigns are the exception. A lead from
-- a campaign the admin routes here is handed to one agent the moment it lands,
-- that agent's phone rings, and the stage they pick after the call is the
-- lead's stage. The 8X mirror and the 8X push both leave such a lead alone, so
-- two systems never fight over one person.

-- ── Agents ──────────────────────────────────────────────────────────────────
create table if not exists public.agents (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  -- What the agent types to sign in. Lower case, so "Ahmed" and "ahmed" are
  -- the same person rather than two accounts that look identical.
  username       text not null unique,
  password_hash  text not null,                -- scrypt$salt$hash, lib/agents.ts
  phone          text,
  -- active: the admin's switch. An inactive agent cannot sign in and is never
  -- routed to. available: the agent's own on-shift switch in the app.
  active         boolean not null default true,
  available      boolean not null default true,
  last_seen_at   timestamptz,                   -- the app checks in every ~15s
  app_version    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint agents_username_chk check (username = lower(username) and length(username) between 2 and 40)
);

drop trigger if exists agents_touch on public.agents;
create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

-- One row per signed-in device. Only the SHA-256 of the token is stored, so a
-- leaked table is not a set of working logins.
create table if not exists public.agent_sessions (
  token_hash    text primary key,
  agent_id      uuid not null references public.agents(id) on delete cascade,
  device        text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now()
);
create index if not exists agent_sessions_agent_idx on public.agent_sessions (agent_id);

-- ── Routing rules ───────────────────────────────────────────────────────────
create table if not exists public.campaign_routing (
  campaign_id         text primary key,
  campaign_name       text,
  ad_account_id       text,
  enabled             boolean not null default true,
  -- Only leads submitted on/after this are routed. Switching routing on must
  -- not dump a campaign's whole history onto the team's phones; the admin
  -- hands older unworked leads over explicitly (backfill) if they want to.
  since               timestamptz not null default now(),
  -- Speed rule: a lead nobody has called this many minutes after it was handed
  -- out moves to another agent who is on shift. Null = off.
  reassign_after_min  integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint campaign_routing_reassign_chk
    check (reassign_after_min is null or reassign_after_min between 1 and 1440)
);

drop trigger if exists campaign_routing_touch on public.campaign_routing;
create trigger campaign_routing_touch before update on public.campaign_routing
  for each row execute function public.touch_updated_at();

-- Who gets a campaign's leads, and in what share. `assigned` counts what each
-- agent has received since the rule was last saved; the next lead goes to the
-- agent furthest below their share, so 70/30 is exactly 7 in every 10, in an
-- interleaved order, not a coin toss that drifts.
create table if not exists public.lead_routes (
  campaign_id  text not null references public.campaign_routing(campaign_id) on delete cascade,
  agent_id     uuid not null references public.agents(id) on delete cascade,
  weight       integer not null,
  assigned     integer not null default 0,
  primary key (campaign_id, agent_id),
  constraint lead_routes_weight_chk check (weight between 0 and 100)
);
create index if not exists lead_routes_agent_idx on public.lead_routes (agent_id);

-- ── The lead, as an agent works it ──────────────────────────────────────────
alter table public.leads add column if not exists agent_id        uuid references public.agents(id) on delete set null;
alter table public.leads add column if not exists assigned_at     timestamptz;
-- The agent opened the alert (tapped it, or called from it). Ringing stops.
alter table public.leads add column if not exists acked_at        timestamptz;
-- Speed to lead, measured on the agent's own phone: assigned_at -> first_call_at.
alter table public.leads add column if not exists first_call_at   timestamptz;
alter table public.leads add column if not exists last_call_at    timestamptz;
alter table public.leads add column if not exists call_count      integer not null default 0;
alter table public.leads add column if not exists follow_up_at    timestamptz;
alter table public.leads add column if not exists reassign_count  integer not null default 0;
alter table public.leads add column if not exists tried_agent_ids uuid[] not null default '{}';

create index if not exists leads_agent_idx on public.leads (agent_id, assigned_at desc) where agent_id is not null;
create index if not exists leads_unrouted_idx on public.leads (campaign_id, submitted_at) where agent_id is null;
create index if not exists leads_follow_up_idx on public.leads (agent_id, follow_up_at) where follow_up_at is not null;

-- "Phone off / unreachable" is not "no answer": a ringing phone nobody picks up
-- and a number that is switched off call for different follow-ups.
alter table public.leads drop constraint if exists leads_status_chk;
alter table public.leads add constraint leads_status_chk check (status in (
  'new','contacted','no_answer','unreachable','qualified',
  'meeting_booked','meeting_done','site_visit_booked','site_visit_done',
  'eoi','reservation','disqualified'
));

-- Calls and hand-offs live in the same timeline as notes and stage moves.
alter table public.lead_notes drop constraint if exists lead_notes_kind_chk;
alter table public.lead_notes add constraint lead_notes_kind_chk
  check (kind in ('note','stage','call','assign'));

alter table public.agents           enable row level security;
alter table public.agent_sessions   enable row level security;
alter table public.campaign_routing enable row level security;
alter table public.lead_routes      enable row level security;
-- No policies: service_role only, same as every other table here.

-- ── Handing out one lead ────────────────────────────────────────────────────
-- Inside the database, under row locks, because two writers can see the same
-- new lead at once (the minute tick and the ten-minute sync) and a lead given
-- to two agents is two people calling the same customer.
--
-- p_mode:
--   'new'       an unassigned lead submitted on/after the rule's `since`
--   'backfill'  an unassigned lead of any age (the admin asked for it)
--   'reassign'  an assigned lead moves to a DIFFERENT agent who is on shift
--               now; nobody on shift means it stays where it is
--
-- Who is eligible, best first (only the best non-empty tier is used):
--   0  active, on shift, app seen in the last 15 minutes
--   1  active, on shift
--   2  active
-- so a lead always lands somewhere, but never on a phone that is off while a
-- phone that is on is waiting.
create or replace function public.route_lead(p_lead_id text, p_mode text default 'new')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  l          record;
  r          record;
  pick_id    uuid;
  pick_name  text;
begin
  select lead_id, campaign_id, submitted_at, agent_id, status, tried_agent_ids
    into l
    from leads where lead_id = p_lead_id
    for update;
  if not found then return null; end if;

  if p_mode = 'reassign' then
    if l.agent_id is null then return null; end if;
  elsif l.agent_id is not null then
    return l.agent_id;
  end if;

  select * into r from campaign_routing where campaign_id = l.campaign_id and enabled;
  if not found then return null; end if;
  if p_mode = 'new' and l.submitted_at < r.since then return null; end if;

  -- Serialise every hand-out in this campaign, so the counters stay exact.
  perform 1 from lead_routes where campaign_id = l.campaign_id for update;

  with c as (
    select lr.agent_id, lr.weight, lr.assigned, a.name,
           case
             when a.available and a.last_seen_at > now() - interval '15 minutes' then 0
             when a.available then 1
             else 2
           end as tier
      from lead_routes lr
      join agents a on a.id = lr.agent_id
     where lr.campaign_id = l.campaign_id
       and lr.weight > 0
       and a.active
       and (p_mode <> 'reassign'
            or (lr.agent_id <> l.agent_id and not (lr.agent_id = any (l.tried_agent_ids))))
  )
  select agent_id, name into pick_id, pick_name
    from c
   where p_mode <> 'reassign' or tier = 0
   order by tier, (assigned + 1)::numeric / weight, assigned, random()
   limit 1;

  if pick_id is null then return null; end if;

  update lead_routes set assigned = assigned + 1
   where campaign_id = l.campaign_id and agent_id = pick_id;

  update leads
     set agent_id        = pick_id,
         assigned_at     = now(),
         acked_at        = null,
         owner           = pick_name,
         tried_agent_ids = case when l.agent_id is null then tried_agent_ids
                                else array_append(tried_agent_ids, l.agent_id) end,
         reassign_count  = reassign_count + case when p_mode = 'reassign' then 1 else 0 end
   where lead_id = p_lead_id;

  insert into lead_notes (lead_id, kind, body, author)
  values (p_lead_id, 'assign', pick_name,
          case p_mode when 'reassign' then 'auto-reassign' when 'backfill' then 'admin' else 'routing' end);

  return pick_id;
end;
$$;

-- An agent coming back on shift (or back online after a while) starts level
-- with their share instead of being owed every lead they missed: without this,
-- an agent who was off all morning would get the next twenty leads in a row
-- while everyone else's phone stayed silent.
create or replace function public.rebaseline_agent(p_agent_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  with mine as (
    select campaign_id, weight from lead_routes where agent_id = p_agent_id and weight > 0
  ), totals as (
    select lr.campaign_id, sum(lr.assigned) as assigned, sum(lr.weight) as weight
      from lead_routes lr join mine using (campaign_id)
     where lr.weight > 0
     group by lr.campaign_id
  )
  update lead_routes lr
     set assigned = greatest(lr.assigned, floor(t.assigned * lr.weight::numeric / nullif(t.weight, 0))::integer)
    from totals t
   where lr.campaign_id = t.campaign_id and lr.agent_id = p_agent_id;
$$;

revoke all on function public.route_lead(text, text)   from public, anon, authenticated;
revoke all on function public.rebaseline_agent(uuid)   from public, anon, authenticated;
grant execute on function public.route_lead(text, text) to service_role;
grant execute on function public.rebaseline_agent(uuid) to service_role;
