-- WARSTATE 3.8: chat-scoped creator mode + president deputy management.

create table if not exists public.project_admin_chat_sessions (
  telegram_id bigint not null,
  telegram_chat_id bigint not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (telegram_id, telegram_chat_id)
);

alter table public.project_admin_chat_sessions enable row level security;
revoke all on table public.project_admin_chat_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.project_admin_chat_sessions to service_role;

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

  -- Compatibility: parameter name is kept, but the actor may be either the
  -- Founder or the current President.
  if p_founder_player_id is distinct from s.founder_player_id
     and p_founder_player_id is distinct from s.owner_player_id then
    raise exception 'Заместителей назначает Основатель или Президент.';
  end if;

  select role into target_role
  from public.state_members
  where state_id=p_state_id and player_id=p_target_player_id
  for update;

  if target_role is null then raise exception 'Игрок не является гражданином этого государства.'; end if;
  if target_role in ('founder','president','curator') then raise exception 'Этому участнику нельзя назначить роль заместителя.'; end if;

  if p_enabled then
    select count(*) into deputy_count
    from public.state_members
    where state_id=p_state_id and role in ('deputy','minister');
    if target_role not in ('deputy','minister') and deputy_count >= 3 then raise exception 'Лимит заместителей: 3.'; end if;
    update public.state_members set role='deputy' where state_id=p_state_id and player_id=p_target_player_id;
  else
    update public.state_members set role='citizen'
    where state_id=p_state_id and player_id=p_target_player_id and role in ('deputy','minister');
  end if;

  return jsonb_build_object('ok',true,'enabled',p_enabled);
end;
$$;

revoke all on function public.gw_set_deputy(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.gw_set_deputy(uuid,uuid,uuid,boolean) to service_role;
