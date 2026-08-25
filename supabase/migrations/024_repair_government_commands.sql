-- WARSTATE v2.4 — repair government RPCs after legacy/manual SQL changes
begin;

drop function if exists public.gw_appoint_president(uuid,uuid,uuid);
drop function if exists public.gw_remove_president(uuid,uuid);
drop function if exists public.gw_nominate_founder_for_president(uuid,uuid);
drop function if exists public.gw_vote_for_player(uuid,uuid,uuid);
drop function if exists public.gw_cast_vote(uuid,uuid,uuid);
drop function if exists public.gw_finalize_election(uuid);

-- WARSTATE v2.3 — Founder/President dual office + project-admin test mode
--
-- Founder identity is stored in states.founder_player_id. state_members.role is
-- the active operational office. This lets the Founder become President while
-- preserving Founder-only management rights through founder_player_id.

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
  previous_president uuid;
begin
  select * into s from public.states where id = p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Президента назначает только Основатель.'; end if;

  select role into target_role
  from public.state_members
  where state_id=p_state_id and player_id=p_target_player_id
  for update;
  if target_role is null then raise exception 'Игрок не является гражданином этого государства.'; end if;
  if target_role = 'curator' then raise exception 'Куратор Острова новичков не может быть Президентом.'; end if;

  previous_president := s.owner_player_id;

  -- Restore the Founder's base office if they were the previous President and
  -- are being replaced. Other previous Presidents return to citizen.
  update public.state_members
  set role = case when player_id=s.founder_player_id then 'founder' else 'citizen' end
  where state_id=p_state_id and role='president' and player_id is distinct from p_target_player_id;

  update public.state_members
  set role='president'
  where state_id=p_state_id and player_id=p_target_player_id;

  update public.states set owner_player_id=p_target_player_id where id=p_state_id;
  update public.state_elections set status='cancelled', updated_at=now() where state_id=p_state_id and status='open';

  return jsonb_build_object(
    'ok',true,
    'presidentPlayerId',p_target_player_id,
    'founderIsPresident',p_target_player_id=s.founder_player_id,
    'previousPresidentPlayerId',previous_president
  );
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

  update public.state_members
  set role = case when player_id=s.founder_player_id then 'founder' else 'citizen' end
  where state_id=p_state_id and role='president';

  update public.states set owner_player_id=null where id=p_state_id;
  return jsonb_build_object('ok',true);
end;
$$;

-- A normal Founder can nominate themselves, but this RPC deliberately does not
-- cast a vote. At least one other citizen has to support the nomination.
create or replace function public.gw_nominate_founder_for_president(
  p_state_id uuid,
  p_founder_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  e public.state_elections%rowtype;
  candidate_id uuid;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Самовыдвижение доступно только Основателю этого государства.'; end if;

  select * into e from public.state_elections
  where state_id=p_state_id and status='open' and ends_at>now()
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Сейчас выборы не идут.'; end if;

  insert into public.election_candidates(election_id,player_id,statement)
  values(e.id,p_founder_player_id,'Самовыдвижение Основателя. Требуется голос другого гражданина и большинство среди поданных голосов.')
  on conflict(election_id,player_id) do update set statement=excluded.statement
  returning id into candidate_id;

  return jsonb_build_object('ok',true,'electionId',e.id,'candidateId',candidate_id);
end;
$$;

-- Founders may now be candidates. A normal Founder still reaches this path only
-- through an election/self-nomination flow in the application layer. The RPC is
-- service-role only, so clients cannot bypass that policy directly.
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
  s public.states%rowtype;
  candidate_id uuid;
begin
  select * into e from public.state_elections
  where state_id=p_state_id and status='open' and ends_at>now()
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Сейчас выборы не идут.'; end if;

  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_voter_player_id) then
    raise exception 'Голосовать могут только граждане государства.';
  end if;
  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_target_player_id and role <> 'curator') then
    raise exception 'Кандидат должен быть гражданином этого государства.';
  end if;

  select * into s from public.states where id=p_state_id;
  if s.founder_player_id = p_target_player_id and p_voter_player_id = p_target_player_id then
    raise exception 'Основатель не может голосовать за собственное самовыдвижение. Нужен голос другого гражданина.';
  end if;

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

-- Mini App voting uses gw_cast_vote directly. Apply the same consent rule there
-- so a Founder cannot approve their own candidacy through a different UI path.
create or replace function public.gw_cast_vote(
  p_election_id uuid,
  p_voter_player_id uuid,
  p_candidate_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  candidate public.election_candidates%rowtype;
  s public.states%rowtype;
begin
  select * into e from public.state_elections where id=p_election_id for update;
  if not found then raise exception 'Выборы не найдены.'; end if;
  if e.status <> 'open' or e.ends_at <= now() then raise exception 'Голосование уже закрыто.'; end if;
  if not exists(select 1 from public.state_members where state_id=e.state_id and player_id=p_voter_player_id) then
    raise exception 'Голосовать могут только граждане этого государства.';
  end if;

  select * into candidate from public.election_candidates where id=p_candidate_id and election_id=p_election_id;
  if not found then raise exception 'Кандидат не найден.'; end if;
  select * into s from public.states where id=e.state_id;

  if s.founder_player_id = candidate.player_id and p_voter_player_id = candidate.player_id then
    raise exception 'Основатель не может голосовать за собственное самовыдвижение. Нужен голос другого гражданина.';
  end if;

  insert into public.election_votes(election_id,voter_player_id,candidate_id)
  values(p_election_id,p_voter_player_id,p_candidate_id)
  on conflict(election_id,voter_player_id) do update
    set candidate_id=excluded.candidate_id,created_at=now();
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.gw_finalize_election(
  p_election_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  s public.states%rowtype;
  winner uuid;
  winner_votes bigint;
  total_votes bigint;
  winner_role text;
begin
  select * into e from public.state_elections where id=p_election_id for update;
  if not found then raise exception 'Выборы не найдены.'; end if;
  if e.status='resolved' then return jsonb_build_object('applied',false,'winnerPlayerId',e.winner_player_id); end if;
  if e.status<>'open' then raise exception 'Выборы нельзя завершить.'; end if;
  if e.ends_at>now() then raise exception 'Голосование ещё продолжается.'; end if;

  select * into s from public.states where id=e.state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

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

  if coalesce(winner_votes,0) <= 0 then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true,'reason','no_votes');
  end if;

  select count(*) into total_votes from public.election_votes where election_id=p_election_id;
  if winner=s.founder_player_id and (coalesce(winner_votes,0) < 1 or coalesce(winner_votes,0) * 2 <= coalesce(total_votes,0)) then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true,'reason','founder_requires_majority_support');
  end if;

  select role into winner_role from public.state_members where state_id=e.state_id and player_id=winner for update;
  if winner_role is null then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true,'reason','winner_not_member');
  end if;
  if winner_role='curator' then
    update public.state_elections set status='cancelled',updated_at=now() where id=p_election_id;
    return jsonb_build_object('applied',true,'cancelled',true,'reason','curator_cannot_be_president');
  end if;

  update public.state_members
  set role = case when player_id=s.founder_player_id then 'founder' else 'citizen' end
  where state_id=e.state_id and role='president' and player_id is distinct from winner;

  update public.state_members set role='president' where state_id=e.state_id and player_id=winner;
  update public.states set owner_player_id=winner where id=e.state_id;
  update public.state_elections set status='resolved',winner_player_id=winner,updated_at=now() where id=p_election_id;

  return jsonb_build_object(
    'applied',true,
    'winnerPlayerId',winner,
    'votes',coalesce(winner_votes,0),
    'founderIsPresident',winner=s.founder_player_id
  );
end;
$$;

revoke all on function public.gw_nominate_founder_for_president(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_appoint_president(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_remove_president(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_vote_for_player(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_cast_vote(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_finalize_election(uuid) from public,anon,authenticated;
grant execute on function public.gw_nominate_founder_for_president(uuid,uuid) to service_role;
grant execute on function public.gw_appoint_president(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_remove_president(uuid,uuid) to service_role;
grant execute on function public.gw_vote_for_player(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_cast_vote(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_finalize_election(uuid) to service_role;


create or replace function public.gw_command_health()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', cardinality(missing)=0,
    'missing', to_jsonb(missing)
  )
  from (
    select array_remove(array[
      case when to_regprocedure('public.gw_appoint_president(uuid,uuid,uuid)') is null then 'gw_appoint_president' end,
      case when to_regprocedure('public.gw_remove_president(uuid,uuid)') is null then 'gw_remove_president' end,
      case when to_regprocedure('public.gw_nominate_founder_for_president(uuid,uuid)') is null then 'gw_nominate_founder_for_president' end,
      case when to_regprocedure('public.gw_vote_for_player(uuid,uuid,uuid)') is null then 'gw_vote_for_player' end,
      case when to_regprocedure('public.gw_cast_vote(uuid,uuid,uuid)') is null then 'gw_cast_vote' end,
      case when to_regprocedure('public.gw_finalize_election(uuid)') is null then 'gw_finalize_election' end
    ], null) as missing
  ) q;
$$;

revoke all on function public.gw_command_health() from public,anon,authenticated;
grant execute on function public.gw_command_health() to service_role;

commit;
