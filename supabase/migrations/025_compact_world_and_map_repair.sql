-- WARSTATE v3.6 — compact world layout + island placement repair
-- Safe to run more than once. Gameplay data and state ids are untouched.
begin;

-- island_slot is only a map placement index. Compact it too, otherwise a world
-- with deleted/legacy states can be visually compact today but place the next
-- new island thousands of units away because the old sequence still has gaps.
lock table public.states in share row exclusive mode;
drop index if exists public.idx_states_island_slot;

-- Freeport owns slot 0; playable states are densely numbered 1..N.
update public.states set island_slot = 0 where coalesce(is_freeport, false);
with ordered as (
  select id, row_number() over (order by created_at, id)::bigint as n
  from public.states
  where not coalesce(is_freeport, false)
)
update public.states s set island_slot = o.n
from ordered o
where s.id = o.id;

create unique index if not exists idx_states_island_slot on public.states(island_slot);
select setval(
  'public.gw_island_slot_seq',
  greatest(1, coalesce((select max(island_slot) from public.states), 0)),
  coalesce((select max(island_slot) from public.states), 0) >= 1
);

-- Dense golden-angle spiral. v1.4 used 1800 units, which turned phone
-- navigation into long swipes through empty water. 520 keeps islands distinct
-- while putting several neighbors within one or two gestures.
with ordered as (
  select id, island_slot::double precision as n
  from public.states
  where not coalesce(is_freeport, false)
)
update public.states s
set world_x = 520.0 * sqrt(o.n) * cos(o.n * 2.399963229728653),
    world_y = 520.0 * sqrt(o.n) * sin(o.n * 2.399963229728653)
from ordered o
where s.id = o.id;

-- Freeport remains the neutral landmark in the center.
update public.states set world_x = 0, world_y = 0 where coalesce(is_freeport, false);

-- Future islands use the same compact spacing. Since slots are now dense and
-- Freeport is slot 0, slot N maps directly to spiral point N with no overlap.
create or replace function public.gw_place_island()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  n double precision;
begin
  if new.island_slot is null then
    new.island_slot := nextval('public.gw_island_slot_seq');
  end if;

  if coalesce(new.is_freeport, false) then
    new.world_x := 0;
    new.world_y := 0;
  elsif new.world_x is null or new.world_y is null then
    n := greatest(1, new.island_slot)::double precision;
    new.world_x := 520.0 * sqrt(n) * cos(n * 2.399963229728653);
    new.world_y := 520.0 * sqrt(n) * sin(n * 2.399963229728653);
  end if;

  new.rating_peak := greatest(coalesce(new.rating_peak, 1000), coalesce(new.rating, 1000));
  return new;
end;
$$;

drop trigger if exists trg_gw_place_island on public.states;
create trigger trg_gw_place_island
before insert on public.states
for each row execute function public.gw_place_island();

create index if not exists idx_states_world_xy on public.states(world_x, world_y);
create index if not exists idx_states_rating_rank on public.states(rating desc, created_at, id) where not coalesce(is_freeport, false);

-- The old world RPC calculated every ELO rank with a correlated count, which
-- trends toward O(N²) as more state chats join. Keep the exact API contract but
-- calculate rank once with a window and filter the compact map by distance.
drop function if exists public.gw_get_islands(double precision,double precision,double precision,integer);
create function public.gw_get_islands(
  p_center_x double precision,
  p_center_y double precision,
  p_radius double precision default 2600,
  p_limit integer default 120
) returns table(
  id uuid,name text,color text,emblem text,world_x double precision,world_y double precision,
  telegram_member_count integer,rating integer,island_wins integer,island_losses integer,
  island_integrity integer,win_streak integer,last_battle_at timestamptz,destroyed_until timestamptz,
  shield_until timestamptz,chat_avatar_file_id text,is_freeport boolean,is_beginner_island boolean,
  game_level integer,max_level integer,influence bigint,reputation integer,army_power integer,defense_power integer,
  active_player_count integer,state_size numeric,rank bigint
)
language sql stable security definer set search_path=public
as $$
  with ranked as (
    select
      s.id,s.name,s.color,coalesce(s.emblem,'◆') as emblem,s.world_x,s.world_y,
      greatest(1,coalesce(s.telegram_member_count,1)) as telegram_member_count,
      greatest(0,coalesce(s.rating,1000)) as rating,
      greatest(0,coalesce(s.island_wins,0)) as island_wins,
      greatest(0,coalesce(s.island_losses,0)) as island_losses,
      greatest(0,least(100,coalesce(s.island_integrity,100))) as island_integrity,
      greatest(0,coalesce(s.win_streak,0)) as win_streak,
      s.last_battle_at,s.destroyed_until,s.shield_until,s.chat_avatar_file_id,
      s.is_freeport,s.is_beginner_island,s.game_level,s.max_level,s.influence,s.reputation,
      s.army_power,s.defense_power,s.active_player_count,s.state_size,s.created_at,
      ((s.world_x-p_center_x)^2+(s.world_y-p_center_y)^2) as distance_sq,
      case when s.is_freeport then 0::bigint else
        count(*) filter (where not coalesce(s.is_freeport,false)) over (
          order by greatest(0,coalesce(s.rating,1000)) desc,s.created_at,s.id
          rows between unbounded preceding and current row
        )::bigint
      end as world_rank
    from public.states s
  ), nearby as (
    select * from ranked r
    where r.world_x between p_center_x-greatest(250.0,least(6500.0,p_radius)) and p_center_x+greatest(250.0,least(6500.0,p_radius))
      and r.world_y between p_center_y-greatest(250.0,least(6500.0,p_radius)) and p_center_y+greatest(250.0,least(6500.0,p_radius))
      and r.distance_sq<=power(greatest(250.0,least(6500.0,p_radius)),2)
    order by r.distance_sq asc limit least(greatest(p_limit,1),180)
  )
  select n.id,n.name,n.color,n.emblem,n.world_x,n.world_y,n.telegram_member_count,n.rating,n.island_wins,n.island_losses,
    n.island_integrity,n.win_streak,n.last_battle_at,n.destroyed_until,n.shield_until,n.chat_avatar_file_id,n.is_freeport,n.is_beginner_island,
    n.game_level,n.max_level,n.influence,n.reputation,n.army_power,n.defense_power,n.active_player_count,n.state_size,n.world_rank
  from nearby n order by n.distance_sq asc;
$$;
revoke all on function public.gw_get_islands(double precision,double precision,double precision,integer) from public,anon,authenticated;
grant execute on function public.gw_get_islands(double precision,double precision,double precision,integer) to service_role;

commit;
