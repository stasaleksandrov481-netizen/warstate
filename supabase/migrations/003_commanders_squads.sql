-- GROUP WARS v0.4 / commanders, squads and live orders

alter table public.battle_players
  add column if not exists squad_code text;

create table if not exists public.battle_orders (
  id uuid primary key default gen_random_uuid(),
  battle_id uuid not null references public.battles(id) on delete cascade,
  state_id uuid not null references public.states(id) on delete cascade,
  issued_by_player_id uuid references public.players(id) on delete set null,
  team text not null check (team in ('attacker','defender')),
  point text not null check (point in ('A','B','C')),
  kind text not null check (kind in ('attack','defend','rally')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds'),
  unique (battle_id, state_id)
);

create index if not exists idx_battle_orders_battle on public.battle_orders(battle_id);
create index if not exists idx_battle_orders_expires on public.battle_orders(expires_at);

alter table public.battle_orders enable row level security;
drop policy if exists "public read battle orders" on public.battle_orders;
create policy "public read battle orders" on public.battle_orders for select to anon, authenticated using (true);
grant select on public.battle_orders to anon, authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.battle_orders; exception when duplicate_object then null; end;
end $$;
