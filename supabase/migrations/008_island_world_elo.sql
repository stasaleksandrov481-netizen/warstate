-- GROUP WARS v0.9 / island world + ELO
-- Each Telegram chat is one persistent island on an infinite water plane.

create sequence if not exists public.gw_island_slot_seq start 1;

alter table public.states add column if not exists island_slot bigint;
alter table public.states alter column island_slot set default nextval('public.gw_island_slot_seq');

-- Existing rows receive stable slots once.
update public.states
set island_slot = nextval('public.gw_island_slot_seq')
where island_slot is null;

create unique index if not exists idx_states_island_slot on public.states(island_slot);

alter table public.states add column if not exists world_x double precision;
alter table public.states add column if not exists world_y double precision;
alter table public.states add column if not exists telegram_member_count integer not null default 1 check (telegram_member_count >= 0);
alter table public.states add column if not exists chat_avatar_file_id text;
alter table public.states add column if not exists chat_meta_synced_at timestamptz;
alter table public.states add column if not exists destroyed_until timestamptz;
alter table public.states add column if not exists island_wins integer not null default 0 check (island_wins >= 0);
alter table public.states add column if not exists island_losses integer not null default 0 check (island_losses >= 0);
alter table public.states add column if not exists rating_peak integer not null default 1000 check (rating_peak >= 0);

-- Golden-angle spiral. New chats keep expanding the ocean without a fixed world boundary.
update public.states
set
  world_x = 480.0 * sqrt(greatest(0, island_slot - 1)::double precision)
            * cos((island_slot - 1)::double precision * 2.399963229728653),
  world_y = 480.0 * sqrt(greatest(0, island_slot - 1)::double precision)
            * sin((island_slot - 1)::double precision * 2.399963229728653)
where world_x is null or world_y is null;

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
  if new.world_x is null or new.world_y is null then
    n := greatest(0, new.island_slot - 1)::double precision;
    new.world_x := 480.0 * sqrt(n) * cos(n * 2.399963229728653);
    new.world_y := 480.0 * sqrt(n) * sin(n * 2.399963229728653);
  end if;
  new.rating_peak := greatest(coalesce(new.rating_peak, 1000), coalesce(new.rating, 1000));
  return new;
end;
$$;

drop trigger if exists trg_gw_place_island on public.states;
create trigger trg_gw_place_island
before insert on public.states
for each row execute function public.gw_place_island();

create index if not exists idx_states_world_x on public.states(world_x);
create index if not exists idx_states_world_y on public.states(world_y);
create index if not exists idx_states_rating_desc on public.states(rating desc);

-- Existing realtime battle engine can now represent island-vs-island battles.
alter table public.battles alter column tile_id drop not null;
alter table public.battles add column if not exists battle_kind text not null default 'territory';
alter table public.battles drop constraint if exists battles_battle_kind_check;
alter table public.battles add constraint battles_battle_kind_check check (battle_kind in ('territory','island'));

create unique index if not exists idx_one_active_island_battle_attacker
  on public.battles(attacker_state_id)
  where status in ('scheduled','active') and battle_kind = 'island';
create unique index if not exists idx_one_active_island_battle_defender
  on public.battles(defender_state_id)
  where status in ('scheduled','active') and battle_kind = 'island' and defender_state_id is not null;

create or replace function public.gw_start_island_battle(
  p_attacker_state_id uuid,
  p_defender_state_id uuid,
  p_duration_seconds integer default 180
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  attacker public.states%rowtype;
  defender public.states%rowtype;
  relation public.diplomacy_relations%rowtype;
  pair_a uuid;
  pair_b uuid;
  battle_id uuid;
begin
  if p_attacker_state_id = p_defender_state_id then
    raise exception 'Нельзя атаковать собственный остров.';
  end if;

  -- Deterministic row-lock order avoids attacker/defender deadlocks.
  perform 1 from public.states
  where id in (p_attacker_state_id, p_defender_state_id)
  order by id
  for update;

  select * into attacker from public.states where id = p_attacker_state_id;
  select * into defender from public.states where id = p_defender_state_id;
  if attacker.id is null or defender.id is null then raise exception 'Остров не найден.'; end if;

  if attacker.destroyed_until is not null and attacker.destroyed_until > now() then
    raise exception 'Ваш остров в руинах. Сначала дождитесь восстановления.';
  end if;
  if defender.destroyed_until is not null and defender.destroyed_until > now() then
    raise exception 'Этот остров уже разрушен и временно недоступен для атаки.';
  end if;
  if defender.shield_until is not null and defender.shield_until > now() then
    raise exception 'Остров находится под защитой.';
  end if;
  if attacker.fuel < 120 or attacker.food < 80 then
    raise exception 'Для морской операции нужно 120 топлива и 80 еды.';
  end if;
  if attacker.next_attack_at is not null and attacker.next_attack_at > now() then
    raise exception 'Флот ещё готовится к следующей атаке.';
  end if;
  if exists (
    select 1 from public.battles
    where status in ('scheduled','active')
      and (
        attacker_state_id in (p_attacker_state_id, p_defender_state_id)
        or defender_state_id in (p_attacker_state_id, p_defender_state_id)
      )
  ) then
    raise exception 'Один из островов уже участвует в активной битве.';
  end if;

  if p_attacker_state_id::text < p_defender_state_id::text then
    pair_a := p_attacker_state_id; pair_b := p_defender_state_id;
  else
    pair_a := p_defender_state_id; pair_b := p_attacker_state_id;
  end if;

  select * into relation
  from public.diplomacy_relations
  where state_a_id = pair_a and state_b_id = pair_b
  for update;

  if found and relation.status = 'allied' then
    raise exception 'Нельзя атаковать союзный остров.';
  end if;
  if found and relation.status = 'truce' and relation.truce_until is not null and relation.truce_until > now() then
    raise exception 'Между островами действует перемирие.';
  end if;

  update public.states
  set fuel = fuel - 120,
      food = food - 80,
      next_attack_at = now() + interval '90 seconds'
  where id = p_attacker_state_id;

  insert into public.battles(
    attacker_state_id, defender_state_id, tile_id, battle_kind, status,
    starts_at, ends_at, last_tick_at, point_a_owner, point_b_owner, point_c_owner
  ) values (
    p_attacker_state_id, p_defender_state_id, null, 'island', 'active',
    now(), now() + make_interval(secs => greatest(60, p_duration_seconds)), now(),
    'attacker', null, 'defender'
  ) returning id into battle_id;

  insert into public.diplomacy_relations(state_a_id, state_b_id, status, requested_by_state_id, truce_until, updated_at)
  values (pair_a, pair_b, 'war', p_attacker_state_id, null, now())
  on conflict (state_a_id, state_b_id) do update set
    status = 'war', requested_by_state_id = excluded.requested_by_state_id, truce_until = null, updated_at = now();

  return battle_id;
end;
$$;

-- Finalization handles both the legacy territory mode and the new island mode.
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
  loser_id uuid;
  attacker_won boolean;
  v_resolved_at timestamptz := now();
  attacker_rating integer;
  defender_rating integer;
  expected_attacker double precision;
  attacker_delta integer;
  defender_delta integer;
  loot bigint := 0;
  ruined_until timestamptz;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if not found then raise exception 'Битва не найдена.'; end if;

  if b.status in ('resolved','cancelled') then
    return jsonb_build_object('applied', false, 'battle', to_jsonb(b));
  end if;

  attacker_won := p_attacker_score > p_defender_score;
  winner_id := case when attacker_won then b.attacker_state_id else b.defender_state_id end;
  loser_id := case when attacker_won then b.defender_state_id else b.attacker_state_id end;

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
    select rating into attacker_rating from public.states where id = b.attacker_state_id for update;
    select rating into defender_rating from public.states where id = b.defender_state_id for update;

    expected_attacker := 1.0 / (1.0 + power(10.0, (defender_rating - attacker_rating) / 400.0));
    attacker_delta := round(36.0 * ((case when attacker_won then 1.0 else 0.0 end) - expected_attacker))::integer;
    if attacker_delta = 0 then attacker_delta := case when attacker_won then 1 else -1 end; end if;
    defender_delta := -attacker_delta;

    update public.states
      set rating = greatest(0, rating + attacker_delta),
          rating_peak = greatest(rating_peak, greatest(0, rating + attacker_delta)),
          island_wins = island_wins + case when attacker_won then 1 else 0 end,
          island_losses = island_losses + case when attacker_won then 0 else 1 end
      where id = b.attacker_state_id;

    update public.states
      set rating = greatest(0, rating + defender_delta),
          rating_peak = greatest(rating_peak, greatest(0, rating + defender_delta)),
          island_wins = island_wins + case when attacker_won then 0 else 1 end,
          island_losses = island_losses + case when attacker_won then 1 else 0 end
      where id = b.defender_state_id;

    if attacker_won then
      select least(5000::bigint, floor(credits * 0.12)::bigint) into loot
      from public.states where id = b.defender_state_id for update;
      ruined_until := now() + interval '2 hours';
      update public.states
      set credits = greatest(0, credits - loot),
          destroyed_until = ruined_until,
          shield_until = greatest(coalesce(shield_until, now()), now() + interval '10 hours')
      where id = b.defender_state_id;
      update public.states set credits = credits + loot where id = b.attacker_state_id;
    end if;

    return jsonb_build_object(
      'applied', true,
      'battle', to_jsonb(b),
      'battleKind', 'island',
      'attackerRatingDelta', attacker_delta,
      'defenderRatingDelta', defender_delta,
      'lootCredits', loot,
      'destroyedStateId', case when attacker_won then b.defender_state_id else null end,
      'destroyedUntil', ruined_until
    );
  end if;

  -- Legacy territory mode remains available while old clients/migrations are being phased out.
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

revoke all on function public.gw_start_island_battle(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.gw_start_island_battle(uuid,uuid,integer) to service_role;
revoke all on function public.gw_finalize_battle(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.gw_finalize_battle(uuid,integer,integer) to service_role;

-- Public map data is intentionally public; writes remain service-role only.
do $$
begin
  begin alter publication supabase_realtime add table public.states; exception when duplicate_object then null; end;
end $$;

create or replace function public.gw_get_islands(
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
    s.island_wins, s.island_losses, s.destroyed_until, s.shield_until, s.chat_avatar_file_id,
    (1 + (select count(*) from public.states r where r.rating > s.rating))::bigint as rank
  from public.states s
  where s.world_x between p_center_x - p_radius and p_center_x + p_radius
    and s.world_y between p_center_y - p_radius and p_center_y + p_radius
    and ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) <= p_radius * p_radius
  order by ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) asc
  limit least(greatest(p_limit, 1), 250);
$$;

revoke all on function public.gw_get_islands(double precision,double precision,double precision,integer) from public;
grant execute on function public.gw_get_islands(double precision,double precision,double precision,integer) to service_role;

-- Ruined islands keep only 25% of normal production until automatic recovery.
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
    update public.states set destroyed_until = null where id = p_state_id returning * into s;
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
