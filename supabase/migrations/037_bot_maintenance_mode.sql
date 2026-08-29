-- WARSTATE: global bot maintenance / shutdown mode.
-- One row controls Telegram text commands, callbacks and Mini App API access.
create table if not exists public.bot_runtime_settings (
  id integer primary key check (id = 1),
  enabled boolean not null default true,
  reason text,
  updated_by bigint,
  updated_at timestamptz not null default now()
);

insert into public.bot_runtime_settings (id, enabled, reason)
values (1, true, null)
on conflict (id) do nothing;

alter table public.bot_runtime_settings enable row level security;
revoke all on table public.bot_runtime_settings from public, anon, authenticated;
grant select, insert, update on table public.bot_runtime_settings to service_role;
