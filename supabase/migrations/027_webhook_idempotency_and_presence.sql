-- WARSTATE 3.9 stable: webhook idempotency, safe one-home citizenship and observed Telegram members.
-- No cron jobs are created by this migration.

create table if not exists public.telegram_chat_members (
  telegram_chat_id bigint not null,
  telegram_id bigint not null,
  username text,
  display_name text,
  status text not null default 'member',
  last_seen_at timestamptz not null default now(),
  primary key (telegram_chat_id, telegram_id)
);

create index if not exists idx_telegram_chat_members_user
  on public.telegram_chat_members(telegram_id);
create index if not exists idx_telegram_chat_members_seen
  on public.telegram_chat_members(telegram_chat_id, last_seen_at desc);

alter table public.telegram_chat_members enable row level security;
revoke all on table public.telegram_chat_members from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_chat_members to service_role;

-- Keep both RPC signatures available. The application now calls the two-argument
-- version explicitly, while the one-argument wrapper keeps older deployments safe.
create table if not exists public.telegram_update_receipts (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

create index if not exists idx_telegram_update_receipts_received_at
  on public.telegram_update_receipts(received_at);

drop function if exists public.gw_claim_telegram_update(bigint, integer);
drop function if exists public.gw_claim_telegram_update(bigint);

create or replace function public.gw_claim_telegram_update(
  p_update_id bigint,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id bigint;
  safe_lease integer := greatest(5, least(120, coalesce(p_lease_seconds, 45)));
begin
  if p_update_id is null or p_update_id < 0 then
    return false;
  end if;

  insert into public.telegram_update_receipts(update_id, received_at)
  values (p_update_id, now())
  on conflict (update_id) do update
    set received_at = now()
    where public.telegram_update_receipts.received_at < now() - make_interval(secs => safe_lease)
  returning update_id into claimed_id;

  if mod(abs(p_update_id), 251) = 0 then
    delete from public.telegram_update_receipts
    where update_id in (
      select update_id
      from public.telegram_update_receipts
      where received_at < now() - interval '7 days'
      order by received_at asc
      limit 2000
    );
  end if;

  return claimed_id is not null;
end;
$$;

create or replace function public.gw_claim_telegram_update(p_update_id bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.gw_claim_telegram_update(p_update_id, 45);
$$;

revoke all on function public.gw_claim_telegram_update(bigint,integer) from public,anon,authenticated;
revoke all on function public.gw_claim_telegram_update(bigint) from public,anon,authenticated;
grant execute on function public.gw_claim_telegram_update(bigint,integer) to service_role;
grant execute on function public.gw_claim_telegram_update(bigint) to service_role;

create or replace function public.gw_set_player_home_state(
  p_player_id uuid,
  p_state_id uuid,
  p_role text,
  p_membership_verified_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  membership public.state_members%rowtype;
  player_row public.players%rowtype;
  current_state public.states%rowtype;
  target_state public.states%rowtype;
  previous_member public.state_members%rowtype;
  latest_previous_level integer;
  v_role text:=p_role;
  is_transition boolean:=false;
begin
  select * into player_row from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  select * into target_state from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  if v_role not in ('president','minister','deputy','general','citizen','member','curator') then raise exception 'Некорректная роль.'; end if;

  if player_row.home_state_id is not null and player_row.home_state_id<>p_state_id then
    select * into current_state from public.states where id=player_row.home_state_id for update;
    is_transition:=found;
  end if;

  if is_transition then
    -- Freeport is not a citizenship laundering route: once a player actually
    -- leaves one home state, the same 24h transition cooldown follows them.
    if not current_state.is_freeport and not target_state.is_freeport
      and not current_state.is_beginner_island and not target_state.is_beginner_island then
      raise exception 'Прямой переход между обычными государствами запрещён.';
    end if;

    select * into previous_member from public.state_members where state_id=current_state.id and player_id=p_player_id;

    if target_state.is_beginner_island then
      if current_state.is_freeport then
        select h.state_level into latest_previous_level
        from public.state_membership_history h
        where h.player_id=p_player_id
        order by h.left_at desc limit 1;
        if coalesce(latest_previous_level,1)>3 then
          raise exception 'Вернуться на Остров новичков можно только после государства не выше 3 уровня.';
        end if;
      elsif current_state.game_level>3 then
        raise exception 'Вернуться на Остров новичков можно только из государства не выше 3 уровня.';
      end if;
      if exists(
        select 1 from public.state_membership_history h
        where h.player_id=p_player_id and h.role='president' and h.state_level>3 and h.left_at>now()-interval '7 days'
      ) or (not current_state.is_freeport and previous_member.role='president' and current_state.game_level>3) then
        raise exception 'После управления сильным государством Остров новичков недоступен 7 дней.';
      end if;
    end if;

    if not current_state.is_freeport and previous_member.id is not null then
      insert into public.state_membership_history(player_id,state_id,role,state_level,joined_at,left_at)
      values(p_player_id,current_state.id,previous_member.role,greatest(1,current_state.game_level),previous_member.joined_at,now());
    end if;

    update public.players set
      last_state_change_at=now(),
      contribution_penalty_until=case when current_state.is_beginner_island then now()+interval '72 hours' else contribution_penalty_until end
    where id=p_player_id;
  end if;

  if target_state.is_beginner_island then
    v_role:=case when v_role='curator' then 'curator' else 'citizen' end;
    update public.states set owner_player_id=null,max_level=5 where id=target_state.id;
  elsif v_role='curator' then
    v_role:='citizen';
  end if;

  -- Repeated Telegram updates must be idempotent. With uq_state_members_one_home
  -- an INSERT aimed at an already-existing membership could conflict on player_id
  -- before PostgreSQL reached the older (state_id,player_id) conflict target.
  update public.state_members
  set role=v_role,
      membership_verified_at=p_membership_verified_at
  where player_id=p_player_id and state_id=p_state_id
  returning * into membership;

  if membership.id is null then
    delete from public.state_members where player_id=p_player_id and state_id<>p_state_id;
    insert into public.state_members(state_id,player_id,role,membership_verified_at)
    values(p_state_id,p_player_id,v_role,p_membership_verified_at)
    returning * into membership;
  else
    -- Heal legacy duplicates if the unique index was temporarily absent.
    delete from public.state_members where player_id=p_player_id and state_id<>p_state_id;
  end if;

  update public.players set home_state_id=p_state_id where id=p_player_id;
  return membership.id;
end;
$$;
revoke all on function public.gw_set_player_home_state(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.gw_set_player_home_state(uuid,uuid,text,timestamptz) to service_role;


-- Repeated clicks on the current island are a no-op instead of creating a fake
-- leave/join history entry. Player row locking keeps concurrent switches serial.
create or replace function public.gw_switch_player_state(
  p_player_id uuid,
  p_target_state_id uuid,
  p_membership_verified_at timestamptz default now()
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  player_row public.players%rowtype;
  current_state public.states%rowtype;
  target_state public.states%rowtype;
  membership public.state_members%rowtype;
  previous_member public.state_members%rowtype;
  v_role text := 'citizen';
begin
  select * into player_row from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;

  select * into target_state from public.states where id=p_target_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if target_state.is_freeport then raise exception 'Freeport не требует вступления.'; end if;

  if player_row.home_state_id = p_target_state_id then
    update public.state_members
    set membership_verified_at=p_membership_verified_at
    where player_id=p_player_id and state_id=p_target_state_id
    returning * into membership;
    if membership.id is null then
      v_role := case when target_state.founder_player_id=p_player_id then 'founder' else 'citizen' end;
      if target_state.is_beginner_island then v_role := 'citizen'; end if;
      delete from public.state_members where player_id=p_player_id and state_id<>p_target_state_id;
      insert into public.state_members(state_id,player_id,role,membership_verified_at)
      values(p_target_state_id,p_player_id,v_role,p_membership_verified_at)
      returning * into membership;
    end if;
    return membership.id;
  end if;

  if player_row.home_state_id is not null then
    select * into current_state from public.states where id=player_row.home_state_id for update;
    select * into previous_member from public.state_members where state_id=player_row.home_state_id and player_id=p_player_id;

    if previous_member.id is not null and current_state.id is not null then
      insert into public.state_membership_history(player_id,state_id,role,state_level,joined_at,left_at)
      values(p_player_id,current_state.id,previous_member.role,greatest(1,current_state.game_level),previous_member.joined_at,now());
    end if;
  end if;

  v_role := case when target_state.founder_player_id=p_player_id then 'founder' else 'citizen' end;
  if target_state.is_beginner_island then v_role := 'citizen'; end if;

  delete from public.state_members where player_id=p_player_id;
  insert into public.state_members(state_id,player_id,role,membership_verified_at)
  values(p_target_state_id,p_player_id,v_role,p_membership_verified_at)
  returning * into membership;

  update public.players
  set home_state_id=p_target_state_id,
      last_state_change_at=now()
  where id=p_player_id;

  return membership.id;
end;
$$;

revoke all on function public.gw_switch_player_state(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.gw_switch_player_state(uuid,uuid,timestamptz) to service_role;
