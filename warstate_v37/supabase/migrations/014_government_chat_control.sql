-- WARSTATE v1.9.0 / government, state handles, chat activity and 30-minute elections

alter table public.states add column if not exists telegram_chat_title text;
alter table public.states add column if not exists state_username text;
alter table public.states add column if not exists state_username_changed_at timestamptz;
alter table public.states add column if not exists founder_player_id uuid references public.players(id) on delete set null;
alter table public.states add column if not exists founder_verified_at timestamptz;

update public.states
set telegram_chat_title = coalesce(telegram_chat_title, name)
where telegram_chat_title is null;

create unique index if not exists uq_states_state_username_ci
  on public.states(lower(state_username))
  where state_username is not null and is_freeport = false;

alter table public.players add column if not exists last_chat_activity_at timestamptz;
alter table public.players add column if not exists battle_wins integer not null default 0 check (battle_wins >= 0);
alter table public.players add column if not exists battle_defenses integer not null default 0 check (battle_defenses >= 0);

-- Expand state roles for the explicit Founder/President/Deputy/Citizen model while
-- keeping legacy roles readable during rolling deploys.
alter table public.state_members drop constraint if exists state_members_role_check;
alter table public.state_members add constraint state_members_role_check
  check (role in ('founder','president','minister','deputy','general','citizen','member','curator'));

-- Chat-message contribution is authoritative and rate-limited in SQL.
alter table public.contribution_events drop constraint if exists contribution_events_source_check;
alter table public.contribution_events add constraint contribution_events_source_check
  check (source in ('activity','battle','support','building','defense','alliance','migration','chat_message','government'));

create index if not exists idx_states_founder on public.states(founder_player_id);
create index if not exists idx_states_username_lower on public.states(lower(state_username));
create index if not exists idx_members_role on public.state_members(state_id, role);

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
  next_xp integer;
  next_level integer;
begin
  select * into p from public.players where telegram_id = p_telegram_id for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'player_missing'); end if;

  select * into member from public.state_members where state_id = p_state_id and player_id = p.id for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'not_member'); end if;

  if p.last_chat_activity_at is not null and p.last_chat_activity_at > now() - interval '1 minute' then
    return jsonb_build_object('applied', false, 'reason', 'cooldown', 'nextAt', p.last_chat_activity_at + interval '1 minute');
  end if;

  next_xp := p.xp + 2;
  next_level := greatest(p.level, 1 + floor(sqrt(next_xp / 180.0))::integer);

  update public.players
  set xp = next_xp,
      level = next_level,
      last_chat_activity_at = now(),
      last_seen_at = now()
  where id = p.id;

  update public.state_members
  set contribution = contribution + 1
  where id = member.id;

  insert into public.contribution_events(player_id, state_id, source, amount, metadata)
  values(p.id, p_state_id, 'chat_message', 1, jsonb_build_object('telegramId', p_telegram_id));

  return jsonb_build_object('applied', true, 'xp', 2, 'contribution', 1, 'level', next_level);
end;
$$;

revoke all on function public.gw_record_chat_activity(bigint,uuid) from public,anon,authenticated;
grant execute on function public.gw_record_chat_activity(bigint,uuid) to service_role;

create or replace function public.gw_set_state_username(
  p_state_id uuid,
  p_actor_player_id uuid,
  p_username text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  clean text := lower(trim(both '@' from coalesce(p_username,'')));
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_actor_player_id then raise exception 'Юз государства меняет только Основатель.'; end if;
  if clean !~ '^[a-z0-9_]{4,32}$' then raise exception 'Юз: 4–32 символа, только английские буквы, цифры и подчёркивание.'; end if;
  if s.state_username_changed_at is not null and s.state_username is not null and s.state_username_changed_at > now() - interval '30 days' then
    raise exception 'Юз государства можно менять не чаще одного раза в 30 дней.';
  end if;
  if exists(select 1 from public.states where id <> p_state_id and lower(state_username) = clean) then
    raise exception 'Этот юз уже занят.';
  end if;
  update public.states set state_username = clean, state_username_changed_at = now() where id = p_state_id;
  return jsonb_build_object('ok', true, 'username', clean);
end;
$$;

revoke all on function public.gw_set_state_username(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gw_set_state_username(uuid,uuid,text) to service_role;

create or replace function public.gw_rename_state(
  p_state_id uuid,
  p_actor_player_id uuid,
  p_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  clean text := regexp_replace(trim(coalesce(p_name,'')), '\s+', ' ', 'g');
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_actor_player_id then raise exception 'Название государства меняет только Основатель.'; end if;
  if char_length(clean) < 3 or char_length(clean) > 64 then raise exception 'Название должно содержать 3–64 символа.'; end if;
  update public.states set name = clean where id = p_state_id;
  return jsonb_build_object('ok', true, 'name', clean);
end;
$$;

revoke all on function public.gw_rename_state(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gw_rename_state(uuid,uuid,text) to service_role;

create or replace function public.gw_appoint_president(
  p_state_id uuid,
  p_founder_player_id uuid,
  p_target_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  target_role text;
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Президента назначает только Основатель.'; end if;
  select role into target_role from public.state_members where state_id=p_state_id and player_id=p_target_player_id for update;
  if target_role is null then raise exception 'Игрок не является гражданином этого государства.'; end if;
  if target_role = 'founder' then raise exception 'Основатель не может занимать вторую роль. Назначьте другого гражданина.'; end if;

  update public.state_members set role='citizen' where state_id=p_state_id and role='president';
  update public.state_members set role='president' where state_id=p_state_id and player_id=p_target_player_id;
  update public.states set owner_player_id=p_target_player_id where id=p_state_id;
  update public.state_elections set status='cancelled', updated_at=now() where state_id=p_state_id and status='open';
  return jsonb_build_object('ok',true,'presidentPlayerId',p_target_player_id);
end;
$$;

create or replace function public.gw_remove_president(
  p_state_id uuid,
  p_founder_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Президента снимает только Основатель.'; end if;
  update public.state_members set role='citizen' where state_id=p_state_id and role='president';
  update public.states set owner_player_id=null where id=p_state_id;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.gw_set_deputy(
  p_state_id uuid,
  p_founder_player_id uuid,
  p_target_player_id uuid,
  p_enabled boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  target_role text;
  deputy_count integer;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Заместителей назначает Основатель.'; end if;
  select role into target_role from public.state_members where state_id=p_state_id and player_id=p_target_player_id for update;
  if target_role is null then raise exception 'Игрок не является гражданином этого государства.'; end if;
  if target_role in ('founder','president','curator') then raise exception 'Этому участнику нельзя назначить роль заместителя.'; end if;

  if p_enabled then
    select count(*) into deputy_count from public.state_members where state_id=p_state_id and role in ('deputy','minister');
    if target_role not in ('deputy','minister') and deputy_count >= 3 then raise exception 'Лимит заместителей: 3.'; end if;
    update public.state_members set role='deputy' where state_id=p_state_id and player_id=p_target_player_id;
  else
    update public.state_members set role='citizen' where state_id=p_state_id and player_id=p_target_player_id and role in ('deputy','minister');
  end if;
  return jsonb_build_object('ok',true,'enabled',p_enabled);
end;
$$;

revoke all on function public.gw_appoint_president(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_remove_president(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_set_deputy(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.gw_appoint_president(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_remove_president(uuid,uuid) to service_role;
grant execute on function public.gw_set_deputy(uuid,uuid,uuid,boolean) to service_role;

-- Elections are 30 minutes and any citizen can become a candidate when first voted for.
create or replace function public.gw_open_30m_election(
  p_state_id uuid,
  p_founder_player_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  eid uuid;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Внеочередные выборы запускает только Основатель.'; end if;
  if exists(select 1 from public.state_elections where state_id=p_state_id and status='open' and ends_at>now()) then raise exception 'Выборы уже идут.'; end if;
  insert into public.state_elections(state_id,status,starts_at,ends_at,created_by_player_id)
  values(p_state_id,'open',now(),now()+interval '30 minutes',p_founder_player_id)
  returning id into eid;
  return eid;
end;
$$;

create or replace function public.gw_vote_for_player(
  p_state_id uuid,
  p_voter_player_id uuid,
  p_target_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  candidate_id uuid;
begin
  select * into e from public.state_elections
  where state_id=p_state_id and status='open' and ends_at>now()
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Сейчас выборы не идут.'; end if;
  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_voter_player_id) then raise exception 'Голосовать могут только граждане государства.'; end if;
  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_target_player_id and role not in ('curator','founder')) then raise exception 'Кандидат должен быть гражданином этого государства.'; end if;

  insert into public.election_candidates(election_id,player_id,statement)
  values(e.id,p_target_player_id,'Кандидат от граждан государства.')
  on conflict(election_id,player_id) do update set statement=excluded.statement
  returning id into candidate_id;

  insert into public.election_votes(election_id,voter_player_id,candidate_id)
  values(e.id,p_voter_player_id,candidate_id)
  on conflict(election_id,voter_player_id) do update set candidate_id=excluded.candidate_id,created_at=now();
  return jsonb_build_object('ok',true,'electionId',e.id,'candidateId',candidate_id);
end;
$$;

revoke all on function public.gw_open_30m_election(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_vote_for_player(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_open_30m_election(uuid,uuid) to service_role;
grant execute on function public.gw_vote_for_player(uuid,uuid,uuid) to service_role;

-- Preserve Founder/Deputies when an election resolves. owner_player_id remains a
-- compatibility pointer to the current President, never to the Founder.
create or replace function public.gw_finalize_election(
  p_election_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  winner uuid;
  winner_votes bigint;
  winner_role text;
begin
  select * into e from public.state_elections where id=p_election_id for update;
  if not found then raise exception 'Выборы не найдены.'; end if;
  if e.status='resolved' then return jsonb_build_object('applied',false,'winnerPlayerId',e.winner_player_id); end if;
  if e.status<>'open' then raise exception 'Выборы нельзя завершить.'; end if;
  if e.ends_at>now() then raise exception 'Голосование ещё продолжается.'; end if;

  select c.player_id,count(v.voter_player_id)
  into winner,winner_votes
  from public.election_candidates c
  left join public.election_votes v on v.candidate_id=c.id
  where c.election_id=p_election_id
  group by c.id,c.player_id,c.created_at
  order by count(v.voter_player_id) desc,c.created_at asc
  limit 1;

  if winner is null then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true);
  end if;

  select role into winner_role from public.state_members where state_id=e.state_id and player_id=winner for update;
  if winner_role='founder' then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true,'reason','founder_cannot_be_president');
  end if;

  update public.state_members set role='citizen' where state_id=e.state_id and role='president';
  update public.state_members set role='president' where state_id=e.state_id and player_id=winner;
  update public.states set owner_player_id=winner where id=e.state_id;
  update public.state_elections set status='resolved',winner_player_id=winner,updated_at=now() where id=p_election_id;
  return jsonb_build_object('applied',true,'winnerPlayerId',winner,'votes',coalesce(winner_votes,0));
end;
$$;

-- Real-time government changes are useful to every open Mini App.
do $$ begin
  alter publication supabase_realtime add table public.state_members;
exception when duplicate_object then null; end $$;

-- v1.9 strategic refresh: level-1 buildings are the baseline, not bonuses.
-- This keeps a freshly registered state exactly at Army 100 / Defense 120.
create or replace function public.gw_refresh_state_strategy(p_state_id uuid)
returns public.states
language plpgsql
security definer
set search_path=public
as $$
declare
  s public.states%rowtype;
  active_count integer := 1;
  hq_level integer := 1;
  barracks_level integer := 1;
  lab_level integer := 1;
  outpost_level integer := 1;
  trade_level integer := 1;
  computed_level integer := 1;
  computed_size numeric := 1;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  select greatest(1,count(*))::integer into active_count
  from public.state_members sm
  join public.players p on p.id=sm.player_id
  where sm.state_id=p_state_id and p.last_seen_at>=now()-interval '7 days';

  select coalesce(max(level),1) into hq_level from public.buildings where state_id=p_state_id and building_type='hq';
  select coalesce(max(level),1) into barracks_level from public.buildings where state_id=p_state_id and building_type='barracks';
  select coalesce(max(level),1) into lab_level from public.buildings where state_id=p_state_id and building_type='lab';
  select coalesce(max(level),1) into outpost_level from public.buildings where state_id=p_state_id and building_type='outpost';
  select coalesce(max(level),1) into trade_level from public.buildings where state_id=p_state_id and building_type='trade_chamber';

  computed_level:=least(s.max_level,greatest(1,hq_level+floor((greatest(0,barracks_level-1)+greatest(0,lab_level-1)+greatest(0,outpost_level-1)+greatest(0,trade_level-1))/8.0)::integer));
  computed_size:=power(active_count::numeric,0.4)*power(greatest(1,computed_level)::numeric,0.6);

  update public.states set
    active_player_count=active_count,
    state_size=greatest(0.0001,computed_size),
    game_level=computed_level,
    army_power=greatest(100,100+greatest(0,barracks_level-1)*55+greatest(0,lab_level-1)*10+floor(greatest(0,rating-1000)/30.0)::integer),
    defense_power=greatest(120,120+greatest(0,hq_level-1)*45+greatest(0,outpost_level-1)*52+greatest(0,lab_level-1)*12),
    defense_buffer_base=least(0.20,0.06+greatest(0,outpost_level-1)*0.012),
    last_size_refresh_at=now()
  where id=p_state_id
  returning * into s;
  return s;
end;
$$;
revoke all on function public.gw_refresh_state_strategy(uuid) from public,anon,authenticated;
grant execute on function public.gw_refresh_state_strategy(uuid) to service_role;
