-- GROUP WARS v0.6 / daily operations + safer economy/battle writes

alter table public.states
  add column if not exists shield_until timestamptz,
  add column if not exists next_attack_at timestamptz;

create table if not exists public.player_daily_missions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  state_id uuid not null references public.states(id) on delete cascade,
  mission_date date not null default current_date,
  mission_key text not null check (mission_key in ('check_in','join_battle','battle_action','capture_point')),
  title text not null,
  description text not null,
  progress integer not null default 0 check (progress >= 0),
  target integer not null check (target > 0),
  reward_xp integer not null default 0 check (reward_xp >= 0),
  reward_credits integer not null default 0 check (reward_credits >= 0),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(player_id, state_id, mission_date, mission_key)
);

create index if not exists idx_daily_missions_player_date
  on public.player_daily_missions(player_id, mission_date desc);

alter table public.player_daily_missions enable row level security;
-- Deliberately no anon read/write policy: missions are returned through authenticated Vercel routes.

create or replace function public.gw_progress_daily_mission(
  p_player_id uuid,
  p_state_id uuid,
  p_mission_key text,
  p_amount integer default 1
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.player_daily_missions
  set progress = least(target, progress + greatest(1, p_amount))
  where player_id = p_player_id
    and state_id = p_state_id
    and mission_date = current_date
    and mission_key = p_mission_key;
end;
$$;

create or replace function public.gw_claim_daily_mission(
  p_player_id uuid,
  p_state_id uuid,
  p_mission_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.player_daily_missions%rowtype;
  next_xp integer;
  next_level integer;
begin
  select * into m
  from public.player_daily_missions
  where id = p_mission_id and player_id = p_player_id and state_id = p_state_id
  for update;

  if not found then raise exception 'Задание не найдено.'; end if;
  if m.mission_date <> current_date then raise exception 'Это задание уже устарело.'; end if;
  if m.claimed_at is not null then raise exception 'Награда уже получена.'; end if;
  if m.progress < m.target then raise exception 'Задание ещё не выполнено.'; end if;

  update public.player_daily_missions set claimed_at = now() where id = m.id;

  select xp + m.reward_xp into next_xp from public.players where id = p_player_id for update;
  next_level := greatest(1, 1 + floor(sqrt(next_xp / 180.0))::integer);
  update public.players set xp = next_xp, level = greatest(level, next_level) where id = p_player_id;
  update public.states set credits = credits + m.reward_credits where id = p_state_id;
  update public.state_members set contribution = contribution + m.reward_xp where player_id = p_player_id and state_id = p_state_id;

  return jsonb_build_object('xp', m.reward_xp, 'credits', m.reward_credits, 'level', next_level);
end;
$$;

create or replace function public.gw_upgrade_building(
  p_state_id uuid,
  p_building_type text,
  p_credits bigint,
  p_steel bigint,
  p_fuel bigint,
  p_food bigint,
  p_tech bigint
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  b public.buildings%rowtype;
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  select * into b from public.buildings where state_id = p_state_id and building_type = p_building_type for update;
  if not found then raise exception 'Здание не найдено.'; end if;
  if b.level >= 12 then raise exception 'Максимальный уровень здания достигнут.'; end if;
  if s.credits < p_credits or s.steel < p_steel or s.fuel < p_fuel or s.food < p_food or s.tech < p_tech then
    raise exception 'Не хватает ресурсов для улучшения.';
  end if;

  update public.states set
    credits = credits - p_credits,
    steel = steel - p_steel,
    fuel = fuel - p_fuel,
    food = food - p_food,
    tech = tech - p_tech
  where id = p_state_id;

  update public.buildings set level = level + 1, updated_at = now() where id = b.id;
  return b.level + 1;
end;
$$;

create or replace function public.gw_start_battle(
  p_attacker_state_id uuid,
  p_expected_defender_state_id uuid,
  p_tile_id uuid,
  p_duration_seconds integer default 180
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  t public.tiles%rowtype;
  defender public.states%rowtype;
  relation public.diplomacy_relations%rowtype;
  pair_a uuid;
  pair_b uuid;
  war_id uuid;
  battle_id uuid;
begin
  select * into s from public.states where id = p_attacker_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  select * into t from public.tiles where id = p_tile_id for update;
  if not found then raise exception 'Сектор не найден.'; end if;
  if t.owner_state_id = p_attacker_state_id then raise exception 'Эта территория уже ваша.'; end if;
  if t.owner_state_id is distinct from p_expected_defender_state_id then raise exception 'Владелец сектора уже изменился. Обновите карту.'; end if;
  if not exists (
    select 1
    from public.tiles own
    where own.owner_state_id = p_attacker_state_id
      and (
        (own.q = t.q + 1 and own.r = t.r) or
        (own.q = t.q - 1 and own.r = t.r) or
        (own.q = t.q and own.r = t.r + 1) or
        (own.q = t.q and own.r = t.r - 1) or
        (own.q = t.q + 1 and own.r = t.r - 1) or
        (own.q = t.q - 1 and own.r = t.r + 1)
      )
  ) then raise exception 'Атаковать можно только соседний сектор.'; end if;
  if s.fuel < 120 or s.food < 80 then raise exception 'Для операции нужно 120 топлива и 80 еды.'; end if;
  if s.next_attack_at is not null and s.next_attack_at > now() then raise exception 'Штаб ещё готовит следующую операцию.'; end if;

  if exists (
    select 1 from public.battles
    where status in ('scheduled','active')
      and (attacker_state_id = p_attacker_state_id or defender_state_id = p_attacker_state_id)
  ) then raise exception 'Ваше государство уже участвует в активной битве.'; end if;

  if exists (select 1 from public.battles where tile_id = p_tile_id and status in ('scheduled','active')) then
    raise exception 'За этот сектор уже идёт бой.';
  end if;

  if p_expected_defender_state_id is not null then
    select * into defender from public.states where id = p_expected_defender_state_id;
    if defender.shield_until is not null and defender.shield_until > now() then
      raise exception 'Это государство находится под защитой новичка.';
    end if;

    if p_attacker_state_id::text < p_expected_defender_state_id::text then
      pair_a := p_attacker_state_id; pair_b := p_expected_defender_state_id;
    else
      pair_a := p_expected_defender_state_id; pair_b := p_attacker_state_id;
    end if;
    select * into relation from public.diplomacy_relations where state_a_id = pair_a and state_b_id = pair_b for update;
    if found and relation.status = 'allied' then raise exception 'Нельзя атаковать союзника. Сначала разорвите союз.'; end if;
    if found and relation.status = 'truce' and relation.truce_until is not null and relation.truce_until > now() then
      raise exception 'Действует перемирие. Атаковать пока нельзя.';
    end if;
  end if;

  update public.states
  set fuel = fuel - 120,
      food = food - 80,
      next_attack_at = now() + interval '60 seconds'
  where id = p_attacker_state_id;

  insert into public.wars(attacker_state_id, defender_state_id, tile_id, status)
  values (p_attacker_state_id, p_expected_defender_state_id, p_tile_id, 'active')
  returning id into war_id;

  insert into public.battles(
    war_id, attacker_state_id, defender_state_id, tile_id, status,
    starts_at, ends_at, last_tick_at, point_a_owner, point_b_owner, point_c_owner
  ) values (
    war_id, p_attacker_state_id, p_expected_defender_state_id, p_tile_id, 'active',
    now(), now() + make_interval(secs => greatest(30, p_duration_seconds)), now(), 'attacker', null, 'defender'
  ) returning id into battle_id;

  if p_expected_defender_state_id is not null then
    insert into public.diplomacy_relations(state_a_id, state_b_id, status, requested_by_state_id, truce_until, updated_at)
    values (pair_a, pair_b, 'war', p_attacker_state_id, null, now())
    on conflict (state_a_id, state_b_id) do update set
      status = 'war', requested_by_state_id = excluded.requested_by_state_id, truce_until = null, updated_at = now();
  end if;

  return battle_id;
end;
$$;

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
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  elapsed_hours := least(6.0, greatest(0.0, extract(epoch from (now() - s.last_tick_at)) / 3600.0));
  if elapsed_hours >= 0.02 then
    update public.states set
      credits = credits + floor(p_credits_rate * elapsed_hours)::bigint,
      steel = steel + floor(p_steel_rate * elapsed_hours)::bigint,
      fuel = fuel + floor(p_fuel_rate * elapsed_hours)::bigint,
      food = food + floor(p_food_rate * elapsed_hours)::bigint,
      tech = tech + floor(p_tech_rate * elapsed_hours)::bigint,
      last_tick_at = now()
    where id = p_state_id
    returning * into s;
  end if;
  return to_jsonb(s);
end;
$$;

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
    update public.states set rating = rating + 35, credits = credits + 350 where id = b.attacker_state_id;
  else
    update public.tiles set defense = least(8, defense + 1) where id = b.tile_id;
    update public.states set rating = greatest(0, rating - 8) where id = b.attacker_state_id;
  end if;

  return jsonb_build_object('applied', true, 'battle', to_jsonb(b));
end;
$$;

create or replace function public.gw_award_battle_player(
  p_player_id uuid,
  p_state_id uuid,
  p_reward_xp integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_xp integer;
  next_level integer;
begin
  select xp + greatest(0, p_reward_xp) into next_xp from public.players where id = p_player_id for update;
  if next_xp is null then return; end if;
  next_level := greatest(1, 1 + floor(sqrt(next_xp / 180.0))::integer);
  update public.players set xp = next_xp, level = greatest(level, next_level) where id = p_player_id;
  update public.state_members set contribution = contribution + greatest(0, p_reward_xp) where player_id = p_player_id and state_id = p_state_id;
end;
$$;

revoke all on function public.gw_progress_daily_mission(uuid,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.gw_claim_daily_mission(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.gw_upgrade_building(uuid,text,bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
revoke all on function public.gw_start_battle(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.gw_tick_state(uuid,integer,integer,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.gw_finalize_battle(uuid,integer,integer) from public, anon, authenticated;
revoke all on function public.gw_award_battle_player(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.gw_progress_daily_mission(uuid,uuid,text,integer) to service_role;
grant execute on function public.gw_claim_daily_mission(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_upgrade_building(uuid,text,bigint,bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.gw_start_battle(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.gw_tick_state(uuid,integer,integer,integer,integer,integer) to service_role;
grant execute on function public.gw_finalize_battle(uuid,integer,integer) to service_role;
grant execute on function public.gw_award_battle_player(uuid,uuid,integer) to service_role;
