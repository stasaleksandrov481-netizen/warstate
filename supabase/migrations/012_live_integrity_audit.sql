-- GROUP WARS v1.4.1 — live integrity audit.
-- Forward-only hardening for installs that may already have migration 011.
-- Enforces one active in-game citizenship per player and moves citizenship
-- changes into one service-role-only PostgreSQL transaction.

with ranked as (
  select
    sm.id,
    sm.player_id,
    sm.state_id,
    row_number() over (
      partition by sm.player_id
      order by
        (p.home_state_id = sm.state_id) desc,
        (s.owner_player_id = sm.player_id) desc,
        sm.joined_at desc,
        sm.id
    ) as rn
  from public.state_members sm
  join public.players p on p.id = sm.player_id
  join public.states s on s.id = sm.state_id
), chosen as (
  select player_id, state_id
  from ranked
  where rn = 1
)
update public.players p
set home_state_id = c.state_id
from chosen c
where p.id = c.player_id
  and p.home_state_id is distinct from c.state_id;

with ranked as (
  select
    sm.id,
    row_number() over (
      partition by sm.player_id
      order by
        (p.home_state_id = sm.state_id) desc,
        (s.owner_player_id = sm.player_id) desc,
        sm.joined_at desc,
        sm.id
    ) as rn
  from public.state_members sm
  join public.players p on p.id = sm.player_id
  join public.states s on s.id = sm.state_id
)
delete from public.state_members sm
using ranked r
where sm.id = r.id
  and r.rn > 1;

-- A state must not retain a president who is no longer its active citizen.
-- A verified Telegram administrator can reclaim stewardship on the next launch.
update public.states s
set owner_player_id = null
where s.owner_player_id is not null
  and not exists (
    select 1
    from public.state_members sm
    where sm.state_id = s.id
      and sm.player_id = s.owner_player_id
  );

create unique index if not exists uq_state_members_one_home
  on public.state_members(player_id);

create or replace function public.gw_set_player_home_state(
  p_player_id uuid,
  p_state_id uuid,
  p_role text,
  p_membership_verified_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  membership public.state_members%rowtype;
begin
  perform 1
  from public.players
  where id = p_player_id
  for update;

  if not found then
    raise exception 'Игрок не найден.';
  end if;

  if not exists (
    select 1 from public.states where id = p_state_id
  ) then
    raise exception 'Государство не найдено.';
  end if;

  if p_role not in ('president', 'minister', 'general', 'citizen') then
    raise exception 'Некорректная роль.';
  end if;

  delete from public.state_members
  where player_id = p_player_id
    and state_id <> p_state_id;

  insert into public.state_members(
    state_id,
    player_id,
    role,
    membership_verified_at
  ) values (
    p_state_id,
    p_player_id,
    p_role,
    p_membership_verified_at
  )
  on conflict (state_id, player_id) do update set
    role = excluded.role,
    membership_verified_at = excluded.membership_verified_at
  returning * into membership;

  update public.players
  set home_state_id = p_state_id
  where id = p_player_id;

  return membership.id;
end;
$$;

revoke all on function public.gw_set_player_home_state(uuid,uuid,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.gw_set_player_home_state(uuid,uuid,text,timestamptz)
  to service_role;

-- Reassert battle-RPC privileges after migration 011 replaced the function.
revoke all on function public.gw_start_island_battle(uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.gw_start_island_battle(uuid,uuid,integer)
  to service_role;
