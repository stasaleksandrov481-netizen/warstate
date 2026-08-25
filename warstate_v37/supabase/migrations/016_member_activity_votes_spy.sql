-- WARSTATE v2.1.0 / community roles, chat farming, civic votes and spy quests

alter table public.state_members add column if not exists duty_role text;
alter table public.state_members drop constraint if exists state_members_duty_role_check;
alter table public.state_members add constraint state_members_duty_role_check
  check (duty_role is null or duty_role in ('diplomat','spy','miner','worker'));
create index if not exists idx_state_members_duty_role on public.state_members(state_id,duty_role) where duty_role is not null;

alter table public.states add column if not exists chat_message_progress integer not null default 0;
alter table public.states drop constraint if exists states_chat_message_progress_check;
alter table public.states add constraint states_chat_message_progress_check check (chat_message_progress between 0 and 9);

create table if not exists public.state_votes (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  created_by_player_id uuid not null references public.players(id) on delete cascade,
  vote_kind text not null check (vote_kind in ('war','alliance')),
  target_state_id uuid not null references public.states(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','approved','rejected','cancelled')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  resolved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_state_votes_one_actionable on public.state_votes(state_id) where status='open' or (status='approved' and executed_at is null);
create index if not exists idx_state_votes_due on public.state_votes(ends_at) where status='open';

create table if not exists public.state_vote_ballots (
  vote_id uuid not null references public.state_votes(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  choice boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(vote_id,player_id)
);
create index if not exists idx_state_vote_ballots_vote on public.state_vote_ballots(vote_id,choice);

create table if not exists public.spy_quests (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  state_id uuid not null references public.states(id) on delete cascade,
  target_state_id uuid not null references public.states(id) on delete cascade,
  quest_kind text not null check (quest_kind in ('recon','treasury')),
  status text not null default 'active' check (status in ('active','resolved','expired')),
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_spy_quests_player_recent on public.spy_quests(player_id,created_at desc);
create unique index if not exists idx_spy_quests_one_active on public.spy_quests(player_id) where status='active';

alter table public.state_votes enable row level security;
alter table public.state_vote_ballots enable row level security;
alter table public.spy_quests enable row level security;

alter table public.contribution_events drop constraint if exists contribution_events_source_check;
alter table public.contribution_events add constraint contribution_events_source_check
  check (source in ('activity','battle','support','building','defense','alliance','migration','chat_message','government','spy','chat_farm'));

-- Every valid member message advances the state chat farm. Player XP/contribution
-- keeps the old one-minute anti-spam cooldown, while the collective 10-message
-- counter intentionally counts every ordinary member message.
create or replace function public.gw_record_chat_activity(
  p_telegram_id bigint,
  p_state_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  member public.state_members%rowtype;
  s public.states%rowtype;
  next_xp integer;
  next_level integer;
  bundles integer := 0;
  next_progress integer := 0;
begin
  select * into p from public.players where telegram_id = p_telegram_id for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'player_missing', 'resourceBundles', 0); end if;

  select * into member from public.state_members where state_id = p_state_id and player_id = p.id for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'not_member', 'resourceBundles', 0); end if;

  select * into s from public.states where id=p_state_id for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'state_missing', 'resourceBundles', 0); end if;

  bundles := (coalesce(s.chat_message_progress,0) + 1) / 10;
  next_progress := mod(coalesce(s.chat_message_progress,0) + 1, 10);
  update public.states
  set chat_message_progress=next_progress,
      credits=credits+bundles,
      steel=steel+bundles,
      fuel=fuel+bundles,
      food=food+bundles,
      tech=tech+bundles
  where id=p_state_id;

  if bundles > 0 then
    insert into public.contribution_events(player_id,state_id,source,amount,metadata)
    values(p.id,p_state_id,'chat_farm',bundles,jsonb_build_object('messages',10,'allResources',bundles));
  end if;

  if p.last_chat_activity_at is not null and p.last_chat_activity_at > now() - interval '1 minute' then
    return jsonb_build_object('applied', false, 'reason', 'cooldown', 'nextAt', p.last_chat_activity_at + interval '1 minute', 'resourceBundles', bundles, 'chatProgress', next_progress);
  end if;

  next_xp := p.xp + 2;
  next_level := greatest(p.level, 1 + floor(sqrt(next_xp / 180.0))::integer);
  update public.players set xp=next_xp,level=next_level,last_chat_activity_at=now(),last_seen_at=now() where id=p.id;
  update public.state_members set contribution=contribution+1 where id=member.id;
  insert into public.contribution_events(player_id,state_id,source,amount,metadata)
  values(p.id,p_state_id,'chat_message',1,jsonb_build_object('telegramId',p_telegram_id));

  return jsonb_build_object('applied', true, 'xp', 2, 'contribution', 1, 'level', next_level, 'resourceBundles', bundles, 'chatProgress', next_progress);
end;
$$;
revoke all on function public.gw_record_chat_activity(bigint,uuid) from public,anon,authenticated;
grant execute on function public.gw_record_chat_activity(bigint,uuid) to service_role;

create or replace function public.gw_resolve_spy_quest(
  p_quest_id uuid,
  p_player_id uuid,
  p_option text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  q public.spy_quests%rowtype;
  member public.state_members%rowtype;
  own_state public.states%rowtype;
  target public.states%rowtype;
  chance numeric;
  success boolean;
  stolen integer := 0;
  penalty integer := 0;
  result jsonb;
begin
  select * into q from public.spy_quests where id=p_quest_id for update;
  if not found then raise exception 'Шпионский квест не найден.'; end if;
  if q.player_id<>p_player_id then raise exception 'Это не ваш шпионский квест.'; end if;
  if q.status<>'active' then raise exception 'Шпионский квест уже завершён.'; end if;
  if q.expires_at<=now() then
    update public.spy_quests set status='expired',resolved_at=now() where id=q.id;
    raise exception 'Время операции истекло.';
  end if;

  select * into member from public.state_members where state_id=q.state_id and player_id=p_player_id for update;
  if not found or member.duty_role<>'spy' then raise exception 'Специализация «Шпион» больше не активна.'; end if;
  select * into own_state from public.states where id=q.state_id for update;
  select * into target from public.states where id=q.target_state_id for update;
  if own_state.is_freeport or own_state.is_beginner_island then raise exception 'Из защищённой территории шпионские операции недоступны.'; end if;
  if target.is_freeport or target.is_beginner_island then raise exception 'Цель защищена от шпионских операций.'; end if;

  if q.quest_kind='recon' then
    if p_option not in ('silent','contact') then raise exception 'Неизвестный вариант разведки.'; end if;
    chance := case when p_option='silent' then 0.82 else 0.62 end;
    success := random() < chance;
    result := jsonb_build_object(
      'kind','recon','success',success,'option',p_option,
      'army',case when success then target.army_power else round(target.army_power/25.0)*25 end,
      'defense',case when success then target.defense_power else round(target.defense_power/25.0)*25 end,
      'activePlayers',target.active_player_count,
      'integrity',target.island_integrity,
      'credits',case when success then target.credits else null end
    );
  else
    if p_option not in ('bribe','invoice') then raise exception 'Неизвестный вариант операции с казной.'; end if;
    chance := case when p_option='bribe' then 0.68 else 0.54 end;
    success := random() < chance;
    if success then
      stolen := least(target.credits, greatest(15, least(750, floor(target.credits * (case when p_option='bribe' then 0.012 else 0.022 end))::integer)));
      update public.states set credits=greatest(0,credits-stolen) where id=target.id;
      update public.states set credits=credits+stolen,reputation=reputation+1 where id=own_state.id;
    else
      penalty := least(60,own_state.credits);
      update public.states set credits=greatest(0,credits-penalty),reputation=greatest(0,reputation-2) where id=own_state.id;
    end if;
    result := jsonb_build_object('kind','treasury','success',success,'option',p_option,'stolen',stolen,'penalty',penalty);
  end if;

  update public.spy_quests set status='resolved',result=result,resolved_at=now() where id=q.id;
  if success then
    update public.state_members set contribution=contribution + case when q.quest_kind='treasury' then 8 else 4 end where id=member.id;
    insert into public.contribution_events(player_id,state_id,source,amount,metadata)
    values(p_player_id,q.state_id,'spy',case when q.quest_kind='treasury' then 8 else 4 end,result);
  end if;
  return result;
end;
$$;
revoke all on function public.gw_resolve_spy_quest(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gw_resolve_spy_quest(uuid,uuid,text) to service_role;
