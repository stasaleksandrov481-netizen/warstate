-- v1.0: island integrity, campaign damage, streaks and repair.

alter table public.states add column if not exists island_integrity integer not null default 100 check (island_integrity between 0 and 100);
alter table public.states add column if not exists win_streak integer not null default 0 check (win_streak >= 0);
alter table public.states add column if not exists best_win_streak integer not null default 0 check (best_win_streak >= 0);
alter table public.states add column if not exists last_battle_at timestamptz;

create index if not exists idx_states_integrity on public.states(island_integrity);
create index if not exists idx_states_last_battle on public.states(last_battle_at desc);

-- Add campaign data to viewport reads. Drop first because PostgreSQL cannot change
-- a table-returning function signature with CREATE OR REPLACE.
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
  select
    s.id, s.name, s.color, coalesce(s.emblem, '◆') as emblem,
    s.world_x, s.world_y, s.telegram_member_count, s.rating,
    s.island_wins, s.island_losses, s.island_integrity, s.win_streak, s.last_battle_at,
    s.destroyed_until, s.shield_until, s.chat_avatar_file_id,
    (1 + (select count(*) from public.states r where r.rating > s.rating))::bigint as rank
  from public.states s
  where s.world_x between p_center_x - p_radius and p_center_x + p_radius
    and s.world_y between p_center_y - p_radius and p_center_y + p_radius
    and ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) <= p_radius * p_radius
  order by ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) asc
  limit least(greatest(p_limit, 1), 250);
$$;

revoke all on function public.gw_get_islands(double precision,double precision,double precision,integer) from public, anon, authenticated;
grant execute on function public.gw_get_islands(double precision,double precision,double precision,integer) to service_role;

-- Repair is a treasury operation and therefore runs atomically under a row lock.
create or replace function public.gw_repair_island(
  p_state_id uuid,
  p_amount integer default 25
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  repair_amount integer;
  credits_cost bigint;
  steel_cost bigint;
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Остров не найден.'; end if;
  if s.destroyed_until is not null and s.destroyed_until > now() then
    raise exception 'Остров в руинах. Сначала дождитесь аварийного восстановления.';
  end if;
  if exists (
    select 1 from public.battles
    where status in ('scheduled','active')
      and (attacker_state_id = p_state_id or defender_state_id = p_state_id)
  ) then
    raise exception 'Нельзя ремонтировать остров во время активной битвы.';
  end if;
  if s.island_integrity >= 100 then
    raise exception 'Остров уже полностью восстановлен.';
  end if;

  repair_amount := least(greatest(p_amount, 1), 100 - s.island_integrity);
  credits_cost := repair_amount * 24;
  steel_cost := repair_amount * 3;
  if s.credits < credits_cost or s.steel < steel_cost then
    raise exception 'Не хватает ресурсов на ремонт: нужно % кредитов и % стали.', credits_cost, steel_cost;
  end if;

  update public.states
  set credits = credits - credits_cost,
      steel = steel - steel_cost,
      island_integrity = least(100, island_integrity + repair_amount)
  where id = p_state_id
  returning * into s;

  return jsonb_build_object(
    'integrity', s.island_integrity,
    'repaired', repair_amount,
    'creditsCost', credits_cost,
    'steelCost', steel_cost
  );
end;
$$;

revoke all on function public.gw_repair_island(uuid,integer) from public, anon, authenticated;
grant execute on function public.gw_repair_island(uuid,integer) to service_role;

-- Battle finalization now damages island integrity. A successful invasion must
-- normally win several campaigns before a healthy island is reduced to ruins.
create or replace function public.gw_finalize_battle(
  p_battle_id uuid,
  p_attacker_score integer,
  p_defender_score integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.battles%rowtype;
  winner_id uuid;
  attacker_won boolean;
  v_resolved_at timestamptz := now();
  attacker_rating integer;
  defender_rating integer;
  expected_attacker double precision;
  attacker_delta integer;
  defender_delta integer;
  loot bigint := 0;
  ruined_until timestamptz;
  defender_integrity integer := 100;
  new_integrity integer := 100;
  integrity_damage integer := 0;
  score_margin integer := 0;
  island_destroyed boolean := false;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if not found then raise exception 'Битва не найдена.'; end if;

  if b.status in ('resolved','cancelled') then
    return jsonb_build_object('applied', false, 'battle', to_jsonb(b));
  end if;

  attacker_won := p_attacker_score > p_defender_score;
  winner_id := case when attacker_won then b.attacker_state_id else b.defender_state_id end;

  update public.battles set
    status = 'resolved',
    attacker_score = greatest(0, p_attacker_score),
    defender_score = greatest(0, p_defender_score),
    winner_state_id = winner_id,
    resolved_at = v_resolved_at,
    last_tick_at = v_resolved_at
  where id = b.id
  returning * into b;

  if b.battle_kind = 'island' then
    if b.defender_state_id is null then raise exception 'У островной битвы нет защитника.'; end if;

    -- Lock both state rows in deterministic order before changing rating/integrity.
    perform 1 from public.states
    where id in (b.attacker_state_id, b.defender_state_id)
    order by id
    for update;

    select rating into attacker_rating from public.states where id = b.attacker_state_id;
    select rating, island_integrity into defender_rating, defender_integrity from public.states where id = b.defender_state_id;

    expected_attacker := 1.0 / (1.0 + power(10.0, (defender_rating - attacker_rating) / 400.0));
    attacker_delta := round(36.0 * ((case when attacker_won then 1.0 else 0.0 end) - expected_attacker))::integer;
    if attacker_delta = 0 then attacker_delta := case when attacker_won then 1 else -1 end; end if;
    defender_delta := -attacker_delta;

    update public.states
    set rating = greatest(0, rating + attacker_delta),
        rating_peak = greatest(rating_peak, greatest(0, rating + attacker_delta)),
        island_wins = island_wins + case when attacker_won then 1 else 0 end,
        island_losses = island_losses + case when attacker_won then 0 else 1 end,
        win_streak = case when attacker_won then win_streak + 1 else 0 end,
        best_win_streak = greatest(best_win_streak, case when attacker_won then win_streak + 1 else 0 end),
        last_battle_at = v_resolved_at
    where id = b.attacker_state_id;

    update public.states
    set rating = greatest(0, rating + defender_delta),
        rating_peak = greatest(rating_peak, greatest(0, rating + defender_delta)),
        island_wins = island_wins + case when attacker_won then 0 else 1 end,
        island_losses = island_losses + case when attacker_won then 1 else 0 end,
        win_streak = case when attacker_won then 0 else win_streak + 1 end,
        best_win_streak = greatest(best_win_streak, case when attacker_won then 0 else win_streak + 1 end),
        last_battle_at = v_resolved_at
    where id = b.defender_state_id;

    if attacker_won then
      score_margin := greatest(0, p_attacker_score - p_defender_score);
      integrity_damage := least(55, greatest(22, 22 + floor(score_margin / 8.0)::integer));
      new_integrity := greatest(0, defender_integrity - integrity_damage);

      update public.states set island_integrity = new_integrity where id = b.defender_state_id;

      if new_integrity <= 0 then
        island_destroyed := true;
        select least(5000::bigint, floor(credits * 0.12)::bigint) into loot
        from public.states where id = b.defender_state_id;
        ruined_until := now() + interval '2 hours';

        update public.states
        set credits = greatest(0, credits - loot),
            island_integrity = 0,
            destroyed_until = ruined_until,
            shield_until = greatest(coalesce(shield_until, now()), now() + interval '10 hours')
        where id = b.defender_state_id;
        update public.states set credits = credits + loot where id = b.attacker_state_id;
      end if;
    end if;

    return jsonb_build_object(
      'applied', true,
      'battle', to_jsonb(b),
      'battleKind', 'island',
      'attackerRatingDelta', attacker_delta,
      'defenderRatingDelta', defender_delta,
      'integrityDamage', integrity_damage,
      'defenderIntegrity', new_integrity,
      'islandDestroyed', island_destroyed,
      'lootCredits', loot,
      'destroyedStateId', case when island_destroyed then b.defender_state_id else null end,
      'destroyedUntil', ruined_until
    );
  end if;

  -- Legacy territory mode remains available for old clients/migrations.
  if b.war_id is not null then
    update public.wars set
      status = 'resolved',
      winner_state_id = winner_id,
      attacker_power = greatest(0, p_attacker_score),
      defender_power = greatest(0, p_defender_score),
      resolved_at = v_resolved_at
    where id = b.war_id;
  end if;

  if attacker_won then
    update public.tiles set owner_state_id = b.attacker_state_id, defense = 2, is_capital = false where id = b.tile_id;
    update public.states set rating = rating + 35, rating_peak = greatest(rating_peak, rating + 35), credits = credits + 350 where id = b.attacker_state_id;
  else
    update public.tiles set defense = least(8, defense + 1) where id = b.tile_id;
    update public.states set rating = greatest(0, rating - 8) where id = b.attacker_state_id;
  end if;

  return jsonb_build_object('applied', true, 'battle', to_jsonb(b), 'battleKind', 'territory');
end;
$$;

revoke all on function public.gw_finalize_battle(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.gw_finalize_battle(uuid,integer,integer) to service_role;

-- Ruins recover to 55 integrity, then the remaining repair is a resource sink.
-- Damaged non-ruined islands also produce less until repaired.
create or replace function public.gw_tick_state(
  p_state_id uuid,
  p_credits_rate integer,
  p_steel_rate integer,
  p_fuel_rate integer,
  p_food_rate integer,
  p_tech_rate integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  elapsed_hours numeric;
  multiplier numeric := 1.0;
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  if s.destroyed_until is not null and s.destroyed_until > now() then
    multiplier := 0.25;
  elsif s.destroyed_until is not null and s.destroyed_until <= now() then
    update public.states
    set destroyed_until = null,
        island_integrity = greatest(island_integrity, 55)
    where id = p_state_id
    returning * into s;
    multiplier := greatest(0.55, s.island_integrity / 100.0);
  else
    multiplier := greatest(0.55, s.island_integrity / 100.0);
  end if;

  elapsed_hours := least(6.0, greatest(0.0, extract(epoch from (now() - s.last_tick_at)) / 3600.0));
  if elapsed_hours >= 0.02 then
    update public.states set
      credits = credits + floor(p_credits_rate * elapsed_hours * multiplier)::bigint,
      steel = steel + floor(p_steel_rate * elapsed_hours * multiplier)::bigint,
      fuel = fuel + floor(p_fuel_rate * elapsed_hours * multiplier)::bigint,
      food = food + floor(p_food_rate * elapsed_hours * multiplier)::bigint,
      tech = tech + floor(p_tech_rate * elapsed_hours * multiplier)::bigint,
      last_tick_at = now()
    where id = p_state_id
    returning * into s;
  end if;
  return to_jsonb(s);
end;
$$;

revoke all on function public.gw_tick_state(uuid,integer,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.gw_tick_state(uuid,integer,integer,integer,integer,integer) to service_role;
