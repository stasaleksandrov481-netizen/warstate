-- GROUP WARS v0.7 / atomic battle actions
-- Prevents double-taps and concurrent read-modify-write losses during realtime combat.

alter table public.state_members add column if not exists membership_verified_at timestamptz;

create or replace function public.gw_battle_action(
  p_battle_id uuid,
  p_player_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor public.battle_players%rowtype;
  target public.battle_players%rowtype;
  battle public.battles%rowtype;
  actor_name text;
  target_name text;
  v_point text;
  v_class text;
  v_damage integer;
  v_amount integer;
  v_killed boolean := false;
  v_allies integer := 0;
  v_enemies integer := 0;
  v_cooldown timestamptz;
  v_event_type text;
  v_event jsonb := '{}'::jsonb;
begin
  select * into battle from public.battles where id = p_battle_id for update;
  if not found then raise exception 'Битва не найдена.'; end if;
  if battle.status <> 'active' or battle.ends_at <= now() then raise exception 'Битва уже завершена.'; end if;

  select * into actor
  from public.battle_players
  where battle_id = p_battle_id and player_id = p_player_id
  for update;
  if not found then raise exception 'Сначала войдите в битву.'; end if;
  if actor.hp <= 0 then raise exception 'Вы выбиты. Дождитесь возвращения в бой.'; end if;
  if actor.cooldown_until is not null and actor.cooldown_until > now() then raise exception 'Действие ещё перезаряжается.'; end if;

  select display_name into actor_name from public.players where id = actor.player_id;
  actor_name := coalesce(actor_name, 'Игрок');

  if p_action = 'class' then
    v_class := p_payload->>'class';
    if v_class is null or v_class not in ('assault','medic','engineer','scout') then raise exception 'Неизвестный класс.'; end if;
    update public.battle_players set class = v_class, updated_at = now() where id = actor.id;
    return jsonb_build_object('ok', true, 'action', p_action);
  end if;

  if p_action = 'move' then
    v_point := p_payload->>'point';
    if v_point is null or v_point not in ('A','B','C') then raise exception 'Неизвестная точка.'; end if;
    v_cooldown := now() + interval '700 milliseconds';
    update public.battle_players set point = v_point, cooldown_until = v_cooldown, updated_at = now() where id = actor.id;
    v_event_type := 'move';
    v_event := jsonb_build_object('name', actor_name, 'point', v_point);

  elsif p_action = 'capture' then
    select
      coalesce(sum(case when team = actor.team then case when class = 'engineer' then 2 else 1 end else 0 end),0)::integer,
      coalesce(sum(case when team <> actor.team then case when class = 'engineer' then 2 else 1 end else 0 end),0)::integer
    into v_allies, v_enemies
    from public.battle_players
    where battle_id = p_battle_id and point = actor.point and hp > 0;
    if v_allies <= v_enemies then raise exception 'Точка contested: сначала выбейте противника или приведите подкрепление.'; end if;
    if actor.point = 'A' then update public.battles set point_a_owner = actor.team where id = p_battle_id;
    elsif actor.point = 'B' then update public.battles set point_b_owner = actor.team where id = p_battle_id;
    else update public.battles set point_c_owner = actor.team where id = p_battle_id;
    end if;
    update public.battle_players set contribution = contribution + 12, cooldown_until = now() + interval '2600 milliseconds', updated_at = now() where id = actor.id;
    v_event_type := 'capture';
    v_event := jsonb_build_object('name', actor_name, 'point', actor.point, 'team', actor.team);
    perform public.gw_progress_daily_mission(actor.player_id, actor.state_id, 'capture_point', 1);

  elsif p_action = 'fire' then
    select * into target
    from public.battle_players
    where battle_id = p_battle_id and point = actor.point and team <> actor.team and hp > 0
    order by random()
    limit 1
    for update;
    if not found then raise exception 'На этой точке нет живых противников.'; end if;
    v_damage := case actor.class
      when 'assault' then 34 + floor(random()*15)::integer
      when 'medic' then 18 + floor(random()*11)::integer
      when 'engineer' then 24 + floor(random()*15)::integer
      else 28 + floor(random()*28)::integer
    end;
    v_killed := greatest(0, target.hp - v_damage) = 0;
    update public.battle_players set
      hp = greatest(0, hp - v_damage),
      deaths = deaths + case when v_killed then 1 else 0 end,
      respawn_at = case when v_killed then now() + interval '8 seconds' else respawn_at end,
      updated_at = now()
    where id = target.id;
    update public.battle_players set
      kills = kills + case when v_killed then 1 else 0 end,
      contribution = contribution + case when v_killed then 18 else 4 end,
      cooldown_until = now() + case when actor.class = 'scout' then interval '1300 milliseconds' else interval '1800 milliseconds' end,
      updated_at = now()
    where id = actor.id;
    select display_name into target_name from public.players where id = target.player_id;
    v_event_type := case when v_killed then 'kill' else 'hit' end;
    v_event := jsonb_build_object('name', actor_name, 'target', coalesce(target_name,'Противник'), 'damage', v_damage);

  elsif p_action = 'heal' then
    if actor.class <> 'medic' then raise exception 'Лечить может только медик.'; end if;
    select * into target
    from public.battle_players
    where battle_id = p_battle_id and point = actor.point and team = actor.team and hp > 0 and hp < 100
    order by hp asc, id
    limit 1
    for update;
    if not found then raise exception 'Здесь никого не нужно лечить.'; end if;
    v_amount := 24 + floor(random()*17)::integer;
    update public.battle_players set hp = least(100, hp + v_amount), updated_at = now() where id = target.id;
    update public.battle_players set contribution = contribution + 8, cooldown_until = now() + interval '2400 milliseconds', updated_at = now() where id = actor.id;
    select display_name into target_name from public.players where id = target.player_id;
    v_event_type := 'heal';
    v_event := jsonb_build_object('name', actor_name, 'target', coalesce(target_name,'Союзник'), 'amount', v_amount);

  elsif p_action = 'fortify' then
    if actor.class <> 'engineer' then raise exception 'Укреплять точку может только инженер.'; end if;
    if (actor.point = 'A' and battle.point_a_owner is distinct from actor.team)
      or (actor.point = 'B' and battle.point_b_owner is distinct from actor.team)
      or (actor.point = 'C' and battle.point_c_owner is distinct from actor.team) then
      raise exception 'Сначала захватите эту точку.';
    end if;
    if actor.team = 'attacker' then
      update public.battles set attacker_score = attacker_score + 10 where id = p_battle_id;
    else
      update public.battles set defender_score = defender_score + 10 where id = p_battle_id;
    end if;
    update public.battle_players set contribution = contribution + 10, cooldown_until = now() + interval '5 seconds', updated_at = now() where id = actor.id;
    v_event_type := 'capture';
    v_event := jsonb_build_object('name', actor_name, 'point', actor.point, 'team', actor.team, 'fortify', true);

  else
    raise exception 'Неизвестное действие.';
  end if;

  if p_action in ('move','capture','fire','heal','fortify') then
    perform public.gw_progress_daily_mission(actor.player_id, actor.state_id, 'battle_action', 1);
  end if;
  if v_event_type is not null then
    insert into public.battle_events(battle_id, player_id, event_type, payload)
    values (p_battle_id, actor.player_id, v_event_type, v_event);
  end if;
  return jsonb_build_object('ok', true, 'action', p_action, 'killed', v_killed, 'damage', v_damage, 'amount', v_amount);
end;
$$;

revoke all on function public.gw_battle_action(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.gw_battle_action(uuid,uuid,text,jsonb) to service_role;
