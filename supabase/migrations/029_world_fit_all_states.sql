-- WARSTATE v3.10 — expand world read for true map-fit mode
begin;

-- Keep the compact world, but allow the client to request the complete
-- currently populated world when zoomed all the way out.
create or replace function public.gw_get_islands(
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
    where r.world_x between p_center_x-greatest(250.0,least(9000.0,p_radius)) and p_center_x+greatest(250.0,least(9000.0,p_radius))
      and r.world_y between p_center_y-greatest(250.0,least(9000.0,p_radius)) and p_center_y+greatest(250.0,least(9000.0,p_radius))
      and r.distance_sq<=power(greatest(250.0,least(9000.0,p_radius)),2)
    order by r.distance_sq asc limit least(greatest(p_limit,1),500)
  )
  select n.id,n.name,n.color,n.emblem,n.world_x,n.world_y,n.telegram_member_count,n.rating,n.island_wins,n.island_losses,
    n.island_integrity,n.win_streak,n.last_battle_at,n.destroyed_until,n.shield_until,n.chat_avatar_file_id,
    n.is_freeport,n.is_beginner_island,n.game_level,n.max_level,n.influence,n.reputation,n.army_power,n.defense_power,
    n.active_player_count,n.state_size,n.world_rank
  from nearby n;
$$;

commit;
