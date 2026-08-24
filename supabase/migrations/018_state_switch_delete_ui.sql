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
  previous_member public.state_members%rowtype;
  membership public.state_members%rowtype;
  v_role text := 'citizen';
begin
  select * into player_row from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;

  select * into target_state from public.states where id=p_target_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if target_state.is_freeport then raise exception 'Freeport не требует вступления в государство.'; end if;

  if player_row.home_state_id = p_target_state_id then
    select * into membership from public.state_members where state_id=p_target_state_id and player_id=p_player_id;
    if membership.id is null then
      v_role := case when target_state.founder_player_id=p_player_id then 'founder' else 'citizen' end;
      insert into public.state_members(state_id,player_id,role,membership_verified_at)
      values(p_target_state_id,p_player_id,v_role,p_membership_verified_at)
      on conflict(state_id,player_id) do update set membership_verified_at=excluded.membership_verified_at
      returning * into membership;
    else
      update public.state_members set membership_verified_at=p_membership_verified_at where id=membership.id returning * into membership;
    end if;
    return membership.id;
  end if;

  if player_row.last_state_change_at is not null and player_row.last_state_change_at > now()-interval '24 hours' then
    raise exception 'Менять государство можно не чаще одного раза в 24 часа.';
  end if;

  if player_row.home_state_id is not null then
    select * into current_state from public.states where id=player_row.home_state_id for update;
    if found then
      select * into previous_member from public.state_members where state_id=current_state.id and player_id=p_player_id;
      if not current_state.is_freeport and previous_member.id is not null then
        insert into public.state_membership_history(player_id,state_id,role,state_level,joined_at,left_at)
        values(p_player_id,current_state.id,previous_member.role,greatest(1,current_state.game_level),previous_member.joined_at,now());
      end if;
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
      last_state_change_at=now(),
      contribution_penalty_until=case
        when current_state.id is not null and current_state.is_beginner_island then now()+interval '72 hours'
        else contribution_penalty_until
      end
  where id=p_player_id;

  return membership.id;
end;
$$;
revoke all on function public.gw_switch_player_state(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.gw_switch_player_state(uuid,uuid,timestamptz) to service_role;

create or replace function public.gw_delete_state(
  p_state_id uuid,
  p_actor_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  state_row public.states%rowtype;
  freeport_row public.states%rowtype;
  member_row record;
  moved_count integer := 0;
begin
  select * into state_row from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if state_row.is_freeport or state_row.is_beginner_island then raise exception 'Системное государство удалить нельзя.'; end if;
  if state_row.founder_player_id is distinct from p_actor_player_id then raise exception 'Удалить государство может только владелец Telegram-чата.'; end if;

  if exists(
    select 1 from public.battles
    where status in ('scheduled','active')
      and (attacker_state_id=p_state_id or defender_state_id=p_state_id)
  ) then
    raise exception 'Нельзя удалить государство во время активной битвы.';
  end if;

  select * into freeport_row from public.states where is_freeport=true limit 1 for update;
  if not found then raise exception 'Freeport не настроен.'; end if;

  for member_row in select player_id,role,joined_at from public.state_members where state_id=p_state_id loop
    insert into public.state_membership_history(player_id,state_id,role,state_level,joined_at,left_at)
    values(member_row.player_id,p_state_id,member_row.role,greatest(1,state_row.game_level),member_row.joined_at,now());

    delete from public.state_members where state_id=p_state_id and player_id=member_row.player_id;

    update public.players
    set home_state_id=freeport_row.id,
        last_state_change_at=now()
    where id=member_row.player_id;

    insert into public.state_members(state_id,player_id,role,membership_verified_at)
    values(freeport_row.id,member_row.player_id,'citizen',null)
    on conflict(state_id,player_id) do update set role='citizen',membership_verified_at=null;
    moved_count := moved_count + 1;
  end loop;

  delete from public.states where id=p_state_id;

  return jsonb_build_object('deleted',true,'movedPlayers',moved_count,'freeportStateId',freeport_row.id);
end;
$$;
revoke all on function public.gw_delete_state(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_delete_state(uuid,uuid) to service_role;
