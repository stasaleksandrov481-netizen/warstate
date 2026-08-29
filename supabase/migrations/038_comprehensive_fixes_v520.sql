-- WARSTATE v5.2.0 - comprehensive fix migration.
-- 1. Document gw_get_islands full-world usage.
-- 2. Add indexes for bootstrap home-state lookup.
-- 3. Ensure last_state_change_at column exists.
begin;

-- Ensure the islands function can return ALL states when radius is large enough.
comment on function public.gw_get_islands is
  'Returns states within p_radius of the center. p_radius is clamped to 9000 (full world). '
  'The Mini App should pass radius=9000 at far zoom to show every state on the map.';

-- Speed up the bootstrap home-state lookup added in v5.2.0.
create index if not exists players_home_state_idx
  on public.players (home_state_id)
  where home_state_id is not null;

-- Speed up the recent-switch detection query.
create index if not exists players_last_state_change_idx
  on public.players (last_state_change_at)
  where last_state_change_at is not null;

-- Ensure last_state_change_at column exists (it should from 019 migration).
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'players' and column_name = 'last_state_change_at'
  ) then
    alter table public.players add column last_state_change_at timestamptz;
  end if;
end $$;

commit;
