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
