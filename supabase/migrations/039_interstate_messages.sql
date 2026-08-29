-- WARSTATE v5.3.0 — interstate Telegram messaging with reply routing.
begin;

create table if not exists public.state_messages (
  id uuid primary key default gen_random_uuid(),
  source_state_id uuid not null references public.states(id) on delete cascade,
  target_state_id uuid not null references public.states(id) on delete cascade,
  source_player_id uuid references public.players(id) on delete set null,
  source_chat_id bigint not null,
  target_chat_id bigint not null,
  source_message_id bigint,
  target_message_id bigint,
  message_text text not null check (char_length(message_text) between 1 and 1800),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_state_messages_target_telegram_message
  on public.state_messages(target_chat_id, target_message_id)
  where target_message_id is not null;

create index if not exists idx_state_messages_source_state
  on public.state_messages(source_state_id, created_at desc);

create index if not exists idx_state_messages_target_state
  on public.state_messages(target_state_id, created_at desc);

create index if not exists idx_state_messages_reply_lookup
  on public.state_messages(target_chat_id, target_message_id, created_at desc);

alter table public.state_messages enable row level security;

comment on table public.state_messages is
  'Telegram interstate messages. target_chat_id + target_message_id routes Reply messages back to the originating state.';

commit;
