-- GROUP WARS v1.2 — island world correctness + map performance.
-- Fixes missing island campaign fields in gw_get_islands and removes the
-- per-island global rank COUNT that became O(map_items * all_states).

create index if not exists idx_states_world_xy on public.states(world_x, world_y);
create index if not exists idx_states_destroyed_until on public.states(destroyed_until) where destroyed_until is not null;
create index if not exists idx_states_shield_until on public.states(shield_until) where shield_until is not null;
create index if not exists idx_battles_active_state_pair
  on public.battles(attacker_state_id, defender_state_id, status)
  where status in ('scheduled','active');

-- OUT parameters changed since v0.9, so recreate the RPC instead of CREATE OR REPLACE.
drop function if exists public.gw_get_islands(double precision,double precision,double precision,integer);

create function public.gw_get_islands(
  p_center_x double precision,
  p_center_y double precision,
  p_radius double precision default 2600,
  p_limit integer default 120
) returns table(
  id uuid,
  name text,
  color text,
  emblem text,
  world_x double precision,
  world_y double precision,
  telegram_member_count integer,
  rating integer,
  island_wins integer,
  island_losses integer,
  island_integrity integer,
  win_streak integer,
  last_battle_at timestamptz,
  destroyed_until timestamptz,
  shield_until timestamptz,
  chat_avatar_file_id text,
  rank bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with nearby as (
    select
      s.id,
      s.name,
      s.color,
      coalesce(s.emblem, '◆') as emblem,
      s.world_x,
      s.world_y,
      greatest(1, coalesce(s.telegram_member_count, 1)) as telegram_member_count,
      greatest(0, coalesce(s.rating, 1000)) as rating,
      greatest(0, coalesce(s.island_wins, 0)) as island_wins,
      greatest(0, coalesce(s.island_losses, 0)) as island_losses,
      greatest(0, least(100, coalesce(s.island_integrity, 100))) as island_integrity,
      greatest(0, coalesce(s.win_streak, 0)) as win_streak,
      s.last_battle_at,
      s.destroyed_until,
      s.shield_until,
      s.chat_avatar_file_id,
      ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) as distance_sq
    from public.states s
    where s.world_x between p_center_x - greatest(250.0, least(6500.0, p_radius)) and p_center_x + greatest(250.0, least(6500.0, p_radius))
      and s.world_y between p_center_y - greatest(250.0, least(6500.0, p_radius)) and p_center_y + greatest(250.0, least(6500.0, p_radius))
      and ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2)
        <= power(greatest(250.0, least(6500.0, p_radius)), 2)
    order by distance_sq asc
    limit least(greatest(p_limit, 1), 180)
  )
  select
    n.id,
    n.name,
    n.color,
    n.emblem,
    n.world_x,
    n.world_y,
    n.telegram_member_count,
    n.rating,
    n.island_wins,
    n.island_losses,
    n.island_integrity,
    n.win_streak,
    n.last_battle_at,
    n.destroyed_until,
    n.shield_until,
    n.chat_avatar_file_id,
    0::bigint as rank
  from nearby n
  order by n.distance_sq asc;
$$;

revoke all on function public.gw_get_islands(double precision,double precision,double precision,integer) from public, anon, authenticated;
grant execute on function public.gw_get_islands(double precision,double precision,double precision,integer) to service_role;

-- Battle rewards must survive serverless retries / partial failures.
alter table public.battle_players add column if not exists rewarded_at timestamptz;

create or replace function public.gw_award_battle_player_once(
  p_battle_id uuid,
  p_player_id uuid,
  p_state_id uuid,
  p_reward_xp integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bp public.battle_players%rowtype;
  next_xp integer;
  next_level integer;
begin
  select * into bp
  from public.battle_players
  where battle_id = p_battle_id and player_id = p_player_id
  for update;
  if not found then return false; end if;
  if bp.state_id is distinct from p_state_id then raise exception 'Некорректное государство участника.'; end if;
  if bp.rewarded_at is not null then return false; end if;

  update public.battle_players set rewarded_at = now() where id = bp.id;

  select xp + greatest(0, p_reward_xp)
  into next_xp
  from public.players
  where id = p_player_id
  for update;
  if next_xp is null then return false; end if;

  next_level := greatest(1, 1 + floor(sqrt(next_xp / 180.0))::integer);
  update public.players
  set xp = next_xp,
      level = greatest(level, next_level)
  where id = p_player_id;

  update public.state_members
  set contribution = contribution + greatest(0, p_reward_xp)
  where player_id = p_player_id and state_id = p_state_id;

  return true;
end;
$$;

revoke all on function public.gw_award_battle_player_once(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.gw_award_battle_player_once(uuid,uuid,uuid,integer) to service_role;
