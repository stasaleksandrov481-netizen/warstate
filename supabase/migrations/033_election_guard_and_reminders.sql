-- WARSTATE v4.1 — election/anarchy fixes requested after live testing:
--
-- 1) gw_open_30m_election allowed the Founder to reopen elections even while
--    a President was already sitting (the "no President exists" guard only
--    ran for non-Founder callers). Now nobody — Founder included — can open
--    a new election while owner_player_id (President) is set; the Founder
--    must !снятьпрезидента or run an !импичмент first.
-- 2) state_elections gets a last_reminder_at column so the app layer can
--    atomically claim a "remind the chat" window every 5 minutes while an
--    election is open (see lib/dynamic-events.ts maybeRemindElection).
begin;

alter table public.state_elections
  add column if not exists last_reminder_at timestamptz;

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
  actor_is_citizen boolean;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  -- Fixed: this check used to live only inside the "actor is not Founder"
  -- branch below, so the Founder could always reopen elections regardless
  -- of a sitting President. It now applies unconditionally.
  if s.owner_player_id is not null then
    raise exception 'В государстве уже есть президент. Сначала снимите его (!снятьпрезидента) или начните импичмент (!импичмент).';
  end if;

  if s.founder_player_id is distinct from p_founder_player_id then
    select exists(
      select 1 from public.state_members
      where state_id=p_state_id and player_id=p_founder_player_id
    ) into actor_is_citizen;
    if not coalesce(actor_is_citizen, false) then
      raise exception 'Пока Президент не избран, выборы может запустить любой гражданин: сначала вступите в государство командой !вступить.';
    end if;
  end if;

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

commit;
