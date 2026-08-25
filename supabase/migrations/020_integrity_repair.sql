-- WARSTATE v2.9 integrity repair
-- Fixes legacy duplicate memberships that broke PostgREST .single() reads.

with ranked as (
  select id,
         row_number() over (partition by state_id, player_id order by id) as rn
  from public.state_members
)
delete from public.state_members
where id in (select id from ranked where rn > 1);

create unique index if not exists idx_state_members_unique_pair
  on public.state_members(state_id, player_id);

create unique index if not exists idx_players_telegram_unique
  on public.players(telegram_id);

create unique index if not exists idx_states_telegram_chat_unique
  on public.states(telegram_chat_id)
  where telegram_chat_id is not null;
