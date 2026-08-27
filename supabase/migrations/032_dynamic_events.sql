-- WARSTATE v4.0 / dynamic events runtime
-- Chat-driven pressure engine: president vacancy anarchy timer, night mode,
-- periodic daytime emergencies (ЧП) with interactive button reactions, and
-- unassigned-role reminders. Fully event-driven: live Telegram activity claims
-- work in PostgreSQL, exactly like the v2.0 maintenance lease. No Vercel Cron
-- is required; /api/cron/dynamic-events remains an optional backup endpoint.

-- ---------------------------------------------------------------------------
-- 1. Dynamic-event bookkeeping on states
-- ---------------------------------------------------------------------------
alter table public.states
  add column if not exists president_vacant_since timestamptz;

alter table public.states
  add column if not exists last_anarchy_at timestamptz;

alter table public.states
  add column if not exists anarchy_debt bigint not null default 0;

alter table public.states
  add column if not exists night_notified_on text;

alter table public.states
  add column if not exists next_threat_at timestamptz;

alter table public.states
  add column if not exists last_role_nudge_at timestamptz;

create index if not exists idx_states_president_vacant_since
  on public.states(president_vacant_since)
  where president_vacant_since is not null;

create index if not exists idx_states_next_threat_at
  on public.states(next_threat_at)
  where next_threat_at is not null and bot_present = true;

-- ---------------------------------------------------------------------------
-- 2. Minister of Labor (Министр труда)
--    Duty specializations (Шахтёр, Шпион, Дипломат, Рабочий) are assigned by
--    President, Deputies and the Minister of Labor. The Minister of Labor
--    office itself is granted/revoked only by President, Deputies (and the
--    Founder as the state's ultimate authority).
-- ---------------------------------------------------------------------------
alter table public.state_members drop constraint if exists state_members_role_check;
alter table public.state_members add constraint state_members_role_check
  check (role in ('founder','president','minister','deputy','general','citizen','member','curator','labor_minister'));

-- ---------------------------------------------------------------------------
-- 3. Emergency (ЧП) events
--    One open emergency per state is guaranteed by a partial unique index.
--    A threat is resolved by the first button press from any citizen before
--    expires_at; otherwise it is marked failed and the state takes losses.
-- ---------------------------------------------------------------------------
create table if not exists public.state_threat_events (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  threat_kind text not null check (threat_kind in ('raid','phenomenon','riot','intrigue','disaster')),
  status text not null default 'open' check (status in ('open','resolved','failed')),
  threat_slot timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by_player_id uuid references public.players(id) on delete set null,
  resolution_action text,
  loss_profile text not null default 'threat' check (loss_profile in ('threat','anarchy'))
);

create unique index if not exists uq_state_threat_events_open
  on public.state_threat_events(state_id)
  where status = 'open';

create index if not exists idx_state_threat_events_due
  on public.state_threat_events(state_id, status, expires_at);

-- ---------------------------------------------------------------------------
-- 4. Atomic loss application
--    Percentage-based losses floor at zero (check constraints keep resources
--    non-negative) while anarchy_debt accumulates the running deficit, so a
--    state can factually "go into the minus" without breaking table invariants.
--    The chat message intentionally never exposes the exact figures.
-- ---------------------------------------------------------------------------
create or replace function public.gw_apply_state_loss(
  p_state_id uuid,
  p_profile text default 'threat'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  anarchy boolean := coalesce(p_profile = 'anarchy', false);
  lost_credits bigint;
  lost_steel bigint;
  lost_fuel bigint;
  lost_food bigint;
  debt_added bigint;
begin
  if p_profile not in ('threat','anarchy') then
    raise exception 'Unknown loss profile: %', p_profile;
  end if;

  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  lost_credits := floor(s.credits * (case when anarchy then 0.15 else 0.10 end));
  lost_steel   := floor(s.steel   * (case when anarchy then 0.10 else 0.06 end));
  lost_fuel    := floor(s.fuel    * (case when anarchy then 0.10 else 0.06 end));
  lost_food    := floor(s.food    * (case when anarchy then 0.10 else 0.06 end));
  debt_added   := lost_credits + lost_steel + lost_fuel + lost_food;

  update public.states
    set credits = credits - lost_credits,
        steel = steel - lost_steel,
        fuel = fuel - lost_fuel,
        food = food - lost_food,
        anarchy_debt = coalesce(anarchy_debt, 0) + debt_added
    where id = p_state_id;

  return jsonb_build_object(
    'profile', p_profile,
    'lostCredits', lost_credits,
    'lostSteel', lost_steel,
    'lostFuel', lost_fuel,
    'lostFood', lost_food,
    'debtAdded', debt_added
  );
end;
$$;

revoke all on function public.gw_apply_state_loss(uuid,text) from public,anon,authenticated;
grant execute on function public.gw_apply_state_loss(uuid,text) to service_role;

-- Realtime visibility for future Mini App surfaces (harmless for the bot).
do $$ begin
  alter publication supabase_realtime add table public.state_threat_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 5. First elections are citizen-driven
--    The onboarding instructions tell every participant: «Чтобы начать выборы,
--    отправьте команду !выборы». While the state has NO president, any citizen
--    may open the election. Once a president is in office, extraordinary
--    elections return to the Founder-only rule (same error text as before).
-- ---------------------------------------------------------------------------
create or replace function public.gw_open_30m_election(
  p_state_id uuid,
  p_founder_player_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  eid uuid;
  actor_is_citizen boolean;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  if s.founder_player_id is distinct from p_founder_player_id then
    if s.owner_player_id is not null then
      raise exception 'Внеочередные выборы запускает только Основатель.';
    end if;
    select exists(
      select 1 from public.state_members
      where state_id=p_state_id and player_id=p_founder_player_id
    ) into actor_is_citizen;
    if not coalesce(actor_is_citizen, false) then
      raise exception 'Пока Президент не избран, выборы может запустить любой гражданин: сначала вступите в государство командой !вступить.';
    end if;
  end if;

  if exists(select 1 from public.state_elections where state_id=p_state_id and status='open' and ends_at>now()) then
    raise exception 'Выборы уже идут.';
  end if;

  insert into public.state_elections(state_id,status,starts_at,ends_at,created_by_player_id)
  values(p_state_id,'open',now(),now()+interval '30 minutes',p_founder_player_id)
  returning id into eid;
  return eid;
end;
$$;

revoke all on function public.gw_open_30m_election(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_open_30m_election(uuid,uuid) to service_role;
