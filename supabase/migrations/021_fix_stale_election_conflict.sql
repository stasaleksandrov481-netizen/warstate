-- WARSTATE v2.1 — fix "!выборы" failing when a previous election expired
-- but was never finalized.
--
-- uq_state_open_election (migration 007) allows only one row with
-- status='open' per state, with no regard for ends_at. gw_open_30m_election
-- (migration 014) only checked for an open election with ends_at>now(), so
-- an expired-but-unfinalized election (event-driven maintenance is
-- best-effort and throttled — see lib/maintenance.ts) let the guard pass and
-- then hit the unique index on insert, raising a raw duplicate-key error
-- instead of the intended "Выборы уже идут." message. From the group chat
-- this looked like !выборы silently failing.
--
-- Fix: before opening a new election, finalize any expired 'open' election
-- for this state in the same transaction, reusing gw_finalize_election so
-- the winner is resolved exactly as event-driven maintenance would.
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
  stale record;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.founder_player_id is distinct from p_founder_player_id then raise exception 'Внеочередные выборы запускает только Основатель.'; end if;

  for stale in
    select id from public.state_elections
    where state_id=p_state_id and status='open' and ends_at<=now()
    for update
  loop
    perform public.gw_finalize_election(stale.id);
  end loop;

  if exists(select 1 from public.state_elections where state_id=p_state_id and status='open' and ends_at>now()) then
    raise exception 'Выборы уже идут.';
  end if;

  insert into public.state_elections(state_id,status,starts_at,ends_at,created_by_player_id)
  values(p_state_id,'open',now(),now()+interval '30 minutes',p_founder_player_id)
  returning id into eid;
  return eid;
end;
$$;

revoke all on function public.gw_open_30m_election(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_open_30m_election(uuid,uuid) to service_role;
