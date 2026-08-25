-- GROUP WARS v1.4 — live-only onboarding, Freeport and recruitment.
-- Freeport is a real neutral state stored in Supabase. It is never attackable and
-- acts as the default home for Telegram users who open the Mini App outside a group.

alter table public.states add column if not exists is_freeport boolean not null default false;
alter table public.players add column if not exists home_state_id uuid references public.states(id) on delete set null;

-- Transparent battle-balance modifiers. They are persisted with each battle so
-- the same fight is reproducible and the UI can explain why scores differ.
alter table public.battles add column if not exists attacker_size_modifier numeric(6,4) not null default 1;
alter table public.battles add column if not exists defender_size_modifier numeric(6,4) not null default 1;
alter table public.battles add column if not exists defender_buffer integer not null default 0;
alter table public.battles add column if not exists aggression_penalty numeric(6,4) not null default 0;

-- Reserve the center of the world for Freeport. Existing islands too close to the
-- center are moved out deterministically so the hub never overlaps a chat island.
update public.states
set world_x = 760.0 + 360.0 * cos(coalesce(island_slot, 1)::double precision * 2.399963229728653),
    world_y = 360.0 * sin(coalesce(island_slot, 1)::double precision * 2.399963229728653)
where coalesce(is_freeport, false) = false
  and coalesce(world_x, 0)^2 + coalesce(world_y, 0)^2 < 420^2;

insert into public.states(
  telegram_chat_id, name, color, owner_player_id, credits, steel, fuel, food, tech,
  rating, rating_peak, telegram_member_count, world_x, world_y, island_integrity,
  island_wins, island_losses, win_streak, best_win_streak, is_freeport, motto, emblem, theme
)
values (
  0, 'Freeport', '#e6b85a', null, 0, 0, 0, 0, 0,
  1000, 1000, 1, 0, 0, 100,
  0, 0, 0, 0, true, 'Нейтральная гавань свободных игроков', '⚓', 'steel'
)
on conflict (telegram_chat_id) do update set
  name = 'Freeport',
  is_freeport = true,
  owner_player_id = null,
  world_x = 0,
  world_y = 0,
  color = '#e6b85a',
  motto = 'Нейтральная гавань свободных игроков',
  emblem = '⚓';

insert into public.buildings(state_id, building_type, level)
select s.id, b.building_type, 1
from public.states s
cross join (values ('hq'),('barracks'),('mine'),('refinery'),('farm'),('lab')) as b(building_type)
where s.is_freeport = true
on conflict (state_id, building_type) do nothing;

create table if not exists public.recruitment_posts (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null unique references public.states(id) on delete cascade,
  is_open boolean not null default true,
  headline text not null default 'Набор открыт',
  message text not null default '',
  min_level integer not null default 1 check (min_level between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recruitment_requests (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  kind text not null check (kind in ('application','offer')),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','withdrawn')),
  message text not null default '',
  invite_link text,
  decided_by_player_id uuid references public.players(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(state_id, player_id, kind)
);

create index if not exists idx_recruitment_posts_open on public.recruitment_posts(is_open, updated_at desc);
create index if not exists idx_recruitment_requests_player on public.recruitment_requests(player_id, status, updated_at desc);
create index if not exists idx_recruitment_requests_state on public.recruitment_requests(state_id, status, updated_at desc);

alter table public.recruitment_posts enable row level security;
alter table public.recruitment_requests enable row level security;
-- No anon/client policies: recruitment data is served by authenticated Vercel routes only.

-- Keep the Freeport population in sync with real player memberships.
create or replace function public.gw_sync_freeport_population()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  freeport_id uuid;
begin
  select id into freeport_id from public.states where is_freeport = true limit 1;
  if freeport_id is null then return null; end if;
  update public.states
  set telegram_member_count = greatest(1, (select count(*)::integer from public.state_members where state_id = freeport_id)),
      chat_meta_synced_at = now()
  where id = freeport_id;
  return null;
end;
$$;

drop trigger if exists trg_gw_freeport_population_insert on public.state_members;
create trigger trg_gw_freeport_population_insert
after insert or delete on public.state_members
for each statement execute function public.gw_sync_freeport_population();

update public.states s
set telegram_member_count = greatest(1, (select count(*)::integer from public.state_members m where m.state_id = s.id))
where s.is_freeport = true;

-- Recreate island viewport RPC with the neutral flag.
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
  is_freeport boolean,
  rank bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with nearby as (
    select
      s.id, s.name, s.color, coalesce(s.emblem, '◆') as emblem,
      s.world_x, s.world_y,
      greatest(1, coalesce(s.telegram_member_count, 1)) as telegram_member_count,
      greatest(0, coalesce(s.rating, 1000)) as rating,
      greatest(0, coalesce(s.island_wins, 0)) as island_wins,
      greatest(0, coalesce(s.island_losses, 0)) as island_losses,
      greatest(0, least(100, coalesce(s.island_integrity, 100))) as island_integrity,
      greatest(0, coalesce(s.win_streak, 0)) as win_streak,
      s.last_battle_at, s.destroyed_until, s.shield_until, s.chat_avatar_file_id,
      s.is_freeport,
      ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) as distance_sq
    from public.states s
    where s.world_x between p_center_x - greatest(250.0, least(6500.0, p_radius)) and p_center_x + greatest(250.0, least(6500.0, p_radius))
      and s.world_y between p_center_y - greatest(250.0, least(6500.0, p_radius)) and p_center_y + greatest(250.0, least(6500.0, p_radius))
      and ((s.world_x - p_center_x)^2 + (s.world_y - p_center_y)^2) <= power(greatest(250.0, least(6500.0, p_radius)), 2)
    order by distance_sq asc
    limit least(greatest(p_limit, 1), 180)
  )
  select n.id,n.name,n.color,n.emblem,n.world_x,n.world_y,n.telegram_member_count,n.rating,
         n.island_wins,n.island_losses,n.island_integrity,n.win_streak,n.last_battle_at,
         n.destroyed_until,n.shield_until,n.chat_avatar_file_id,n.is_freeport,0::bigint
  from nearby n
  order by n.distance_sq asc;
$$;
revoke all on function public.gw_get_islands(double precision,double precision,double precision,integer) from public, anon, authenticated;
grant execute on function public.gw_get_islands(double precision,double precision,double precision,integer) to service_role;

-- Freeport can never participate in an island battle. Keep the rest of the v0.9
-- battle validation intact and fail early in the RPC itself, not only in the UI.
create or replace function public.gw_assert_not_freeport_battle(p_attacker uuid, p_defender uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists(select 1 from public.states where id in (p_attacker,p_defender) and is_freeport = true) then
    raise exception 'Freeport — нейтральная территория. Здесь запрещены войны.';
  end if;
end;
$$;
revoke all on function public.gw_assert_not_freeport_battle(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gw_assert_not_freeport_battle(uuid,uuid) to service_role;

-- Re-define the island-battle transaction itself so Freeport neutrality is
-- enforced in PostgreSQL even if a future API route forgets the application check.
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
  attacker_hq integer := 1;
  defender_hq integer := 1;
  attacker_size double precision := 1;
  defender_size double precision := 1;
  size_ratio double precision := 1;
  attacker_modifier double precision := 1;
  defender_modifier double precision := 1;
  recent_attacks integer := 0;
  aggression double precision := 0;
  defense_buffer integer := 0;
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
  if coalesce(attacker.is_freeport, false) or coalesce(defender.is_freeport, false) then
    raise exception 'Freeport — нейтральная территория. Здесь запрещены войны.';
  end if;

  select coalesce(max(level), 1) into attacker_hq
  from public.buildings where state_id = p_attacker_state_id and building_type = 'hq';
  select coalesce(max(level), 1) into defender_hq
  from public.buildings where state_id = p_defender_state_id and building_type = 'hq';

  -- state_size ≈ active_population^0.4 * development^0.6. Telegram gives
  -- reliable total membership, so v1.4 uses it until activity windows are
  -- accumulated for enough real users.
  attacker_size := power(greatest(1, coalesce(attacker.telegram_member_count, 1))::double precision, 0.4)
                   * power(greatest(1, attacker_hq)::double precision, 0.6);
  defender_size := power(greatest(1, coalesce(defender.telegram_member_count, 1))::double precision, 0.4)
                   * power(greatest(1, defender_hq)::double precision, 0.6);
  size_ratio := greatest(0.0001, attacker_size / greatest(0.0001, defender_size));

  if size_ratio > 1 then
    attacker_modifier := 1 - least(0.30, 0.08 * (ln(size_ratio) / ln(2.0)));
    defender_modifier := 1 + least(0.25, 0.07 * (ln(size_ratio) / ln(2.0)));
  end if;

  select count(*)::integer into recent_attacks
  from public.battles
  where attacker_state_id = p_attacker_state_id
    and created_at >= now() - interval '7 days';
  if recent_attacks >= 3 then
    aggression := least(0.15, (recent_attacks - 2) * 0.05);
    attacker_modifier := attacker_modifier * (1 - aggression);
  end if;

  -- The defender starts with a modest buffer representing local knowledge,
  -- fortifications and preparation. HQ development increases the buffer.
  defense_buffer := 8 + greatest(1, defender_hq) * 4;

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
    starts_at, ends_at, last_tick_at, attacker_score, defender_score,
    point_a_owner, point_b_owner, point_c_owner,
    attacker_size_modifier, defender_size_modifier, defender_buffer, aggression_penalty
  ) values (
    p_attacker_state_id, p_defender_state_id, null, 'island', 'active',
    now(), now() + make_interval(secs => greatest(60, p_duration_seconds)), now(),
    0, defense_buffer, 'attacker', null, 'defender',
    round(attacker_modifier::numeric, 4), round(defender_modifier::numeric, 4), defense_buffer, round(aggression::numeric, 4)
  ) returning id into battle_id;

  insert into public.diplomacy_relations(state_a_id, state_b_id, status, requested_by_state_id, truce_until, updated_at)
  values (pair_a, pair_b, 'war', p_attacker_state_id, null, now())
  on conflict (state_a_id, state_b_id) do update set
    status = 'war', requested_by_state_id = excluded.requested_by_state_id, truce_until = null, updated_at = now();

  return battle_id;
end;
$$;

-- v1.4 islands can grow much larger than the old fixed SVG islands. Spread chat
-- islands farther apart and use the same spacing for future inserts.
update public.states
set world_x = 1800.0 * sqrt(greatest(1, coalesce(island_slot, 2) - 1)::double precision)
              * cos((coalesce(island_slot, 2) - 1)::double precision * 2.399963229728653),
    world_y = 1800.0 * sqrt(greatest(1, coalesce(island_slot, 2) - 1)::double precision)
              * sin((coalesce(island_slot, 2) - 1)::double precision * 2.399963229728653)
where is_freeport = false;

create or replace function public.gw_place_island()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  n double precision;
begin
  if new.island_slot is null then new.island_slot := nextval('public.gw_island_slot_seq'); end if;
  if coalesce(new.is_freeport, false) then
    new.world_x := 0;
    new.world_y := 0;
  elsif new.world_x is null or new.world_y is null then
    n := greatest(1, new.island_slot - 1)::double precision;
    new.world_x := 1800.0 * sqrt(n) * cos(n * 2.399963229728653);
    new.world_y := 1800.0 * sqrt(n) * sin(n * 2.399963229728653);
  end if;
  new.rating_peak := greatest(coalesce(new.rating_peak, 1000), coalesce(new.rating, 1000));
  return new;
end;
$$;
