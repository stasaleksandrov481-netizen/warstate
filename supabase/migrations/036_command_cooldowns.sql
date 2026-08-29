-- WARSTATE v5.1.1: throttle spam-prone chat commands / Mini App actions (e.g. repeated !вступить,
-- repeated taps on "Перейти", repeated invite-link DMs) without touching the underlying game logic.

create table if not exists public.command_cooldowns (
  chat_id bigint not null,
  telegram_id bigint not null,
  command text not null,
  last_at timestamptz not null default now(),
  primary key (chat_id, telegram_id, command)
);

create index if not exists idx_command_cooldowns_last_at on public.command_cooldowns(last_at);

alter table public.command_cooldowns enable row level security;
revoke all on table public.command_cooldowns from public, anon, authenticated;
grant select, insert, update, delete on table public.command_cooldowns to service_role;

-- Atomic "try to claim this action" check: returns true if the caller may proceed (and records the
-- attempt), false if the same (chat, user, command) tuple already fired within the cooldown window.
create or replace function public.gw_try_command_cooldown(
  p_chat_id bigint,
  p_telegram_id bigint,
  p_command text,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_window integer := greatest(1, least(3600, coalesce(p_window_seconds, 10)));
  updated_at timestamptz;
begin
  insert into public.command_cooldowns(chat_id, telegram_id, command, last_at)
  values (p_chat_id, p_telegram_id, p_command, now())
  on conflict (chat_id, telegram_id, command) do update
    set last_at = now()
    where public.command_cooldowns.last_at < now() - make_interval(secs => safe_window)
  returning last_at into updated_at;

  return updated_at is not null;
end;
$$;

revoke all on function public.gw_try_command_cooldown(bigint, bigint, text, integer) from public, anon, authenticated;
grant execute on function public.gw_try_command_cooldown(bigint, bigint, text, integer) to service_role;

-- Periodic housekeeping is optional (row count stays tiny); left for a manual cron/admin task if desired.
