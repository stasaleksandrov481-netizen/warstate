-- GROUP WARS / Supabase schema
-- Run in Supabase SQL Editor or with `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  number integer not null unique,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  username text,
  display_name text not null,
  avatar_url text,
  level integer not null default 1 check (level >= 1),
  xp integer not null default 0 check (xp >= 0),
  energy integer not null default 100 check (energy between 0 and 100),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.states (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null unique,
  name text not null,
  color text not null default '#9b7cff',
  owner_player_id uuid references public.players(id) on delete set null,
  capital_tile_id uuid,
  credits bigint not null default 6000 check (credits >= 0),
  steel bigint not null default 1200 check (steel >= 0),
  fuel bigint not null default 600 check (fuel >= 0),
  food bigint not null default 1500 check (food >= 0),
  tech bigint not null default 120 check (tech >= 0),
  rating integer not null default 1000 check (rating >= 0),
  last_tick_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.state_members (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  role text not null default 'citizen' check (role in ('president','minister','general','citizen')),
  contribution bigint not null default 0,
  joined_at timestamptz not null default now(),
  unique(state_id, player_id)
);

create table if not exists public.buildings (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  building_type text not null check (building_type in ('hq','barracks','mine','refinery','farm','lab')),
  level integer not null default 1 check (level between 1 and 12),
  updated_at timestamptz not null default now(),
  unique(state_id, building_type)
);

create table if not exists public.tiles (
  id uuid primary key default gen_random_uuid(),
  q integer not null,
  r integer not null,
  terrain text not null default 'plain' check (terrain in ('plain','forest','mountain','city','oil','ruins')),
  resource_type text check (resource_type in ('credits','steel','fuel','food','tech')),
  defense integer not null default 1 check (defense between 1 and 8),
  owner_state_id uuid references public.states(id) on delete set null,
  is_capital boolean not null default false,
  created_at timestamptz not null default now(),
  unique(q, r)
);

alter table public.states
  drop constraint if exists states_capital_tile_id_fkey;
alter table public.states
  add constraint states_capital_tile_id_fkey foreign key (capital_tile_id) references public.tiles(id) on delete set null;

create table if not exists public.wars (
  id uuid primary key default gen_random_uuid(),
  attacker_state_id uuid not null references public.states(id) on delete cascade,
  defender_state_id uuid references public.states(id) on delete set null,
  tile_id uuid not null references public.tiles(id) on delete cascade,
  status text not null default 'resolved' check (status in ('scheduled','active','resolved','cancelled')),
  attacker_power integer not null default 0,
  defender_power integer not null default 0,
  winner_state_id uuid references public.states(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  telegram_charge_id text not null unique,
  player_id uuid references public.players(id) on delete set null,
  state_id uuid references public.states(id) on delete set null,
  sku text not null,
  stars integer not null check (stars > 0),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.players(id) on delete cascade,
  state_id uuid references public.states(id) on delete cascade,
  sku text not null,
  source_charge_id text not null unique,
  created_at timestamptz not null default now(),
  check (player_id is not null or state_id is not null)
);

create index if not exists idx_state_members_state on public.state_members(state_id);
create index if not exists idx_state_members_player on public.state_members(player_id);
create index if not exists idx_tiles_owner on public.tiles(owner_state_id);
create index if not exists idx_wars_attacker on public.wars(attacker_state_id, created_at desc);
create index if not exists idx_wars_defender on public.wars(defender_state_id, created_at desc);

-- One initial season. Change dates before production launch if needed.
insert into public.seasons(name, number, starts_at, ends_at, active)
values ('Founders Season', 1, now(), now() + interval '28 days', true)
on conflict (number) do nothing;

-- Radius-6 axial hex map = 127 territories.
-- Deterministic terrain lets every fresh project get the same starter world.
insert into public.tiles(q, r, terrain, resource_type, defense)
select
  q,
  r,
  case
    when mod(abs(q * 7 + r * 11), 13) = 0 then 'city'
    when mod(abs(q * 7 + r * 11), 11) = 0 then 'oil'
    when mod(abs(q * 7 + r * 11), 7) = 0 then 'mountain'
    when mod(abs(q * 7 + r * 11), 5) = 0 then 'forest'
    when mod(abs(q * 7 + r * 11), 17) = 0 then 'ruins'
    else 'plain'
  end,
  case
    when mod(abs(q * 7 + r * 11), 13) = 0 then 'credits'
    when mod(abs(q * 7 + r * 11), 11) = 0 then 'fuel'
    when mod(abs(q * 7 + r * 11), 7) = 0 then 'steel'
    else null
  end,
  1 + mod(abs(q * 5 + r * 3), 3)
from generate_series(-6, 6) as q
cross join generate_series(-6, 6) as r
where greatest(abs(q), abs(r), abs(q + r)) <= 6
on conflict (q, r) do nothing;

-- Public map/state reads for Mini App realtime. All writes remain server-side.
alter table public.players enable row level security;
alter table public.states enable row level security;
alter table public.state_members enable row level security;
alter table public.buildings enable row level security;
alter table public.tiles enable row level security;
alter table public.wars enable row level security;
alter table public.payments enable row level security;
alter table public.entitlements enable row level security;
alter table public.seasons enable row level security;

drop policy if exists "public read states" on public.states;
create policy "public read states" on public.states for select to anon, authenticated using (true);
drop policy if exists "public read tiles" on public.tiles;
create policy "public read tiles" on public.tiles for select to anon, authenticated using (true);
drop policy if exists "public read wars" on public.wars;
create policy "public read wars" on public.wars for select to anon, authenticated using (true);
drop policy if exists "public read seasons" on public.seasons;
create policy "public read seasons" on public.seasons for select to anon, authenticated using (true);

-- Buildings can be visible, useful for public state profiles. Players/members/payments remain private.
drop policy if exists "public read buildings" on public.buildings;
create policy "public read buildings" on public.buildings for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on public.states, public.tiles, public.wars, public.seasons, public.buildings to anon, authenticated;

-- Realtime publication. Duplicate additions are ignored.
do $$
begin
  begin alter publication supabase_realtime add table public.tiles; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.states; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.wars; exception when duplicate_object then null; end;
end $$;
