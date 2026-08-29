-- WARSTATE v5.4.1 release-candidate audit fixes.
-- Fixes anti-softlock timestamps, purchase downgrade exploits and legacy auto-invite rows.

-- Private Administration access is owner/admin Reply-only. v5.4 briefly used
-- request_message_id = 0 for bot-minted links; retire those legacy rows.
update public.admin_chat_access_requests
set status = 'cancelled'
where request_message_id = 0
  and status in ('pending', 'fulfilled');

-- Mark humanitarian aid even when a mutation lands exactly on the safety floor.
create or replace function public.gw_enforce_state_resource_floor()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  aid_needed boolean := false;
begin
  if tg_op = 'INSERT' then
    aid_needed := coalesce(new.credits,0) <= 50
      or coalesce(new.steel,0) <= 50
      or coalesce(new.fuel,0) <= 50
      or coalesce(new.food,0) <= 50
      or coalesce(new.tech,0) <= 50;
  else
    -- Mark aid only when a resource actually hits/crosses the reserve. Keeping
    -- one resource at 50 must not refresh the timestamp on every unrelated update.
    aid_needed := coalesce(new.credits,0) < 50 or (coalesce(old.credits,0) > 50 and coalesce(new.credits,0) <= 50)
      or coalesce(new.steel,0) < 50 or (coalesce(old.steel,0) > 50 and coalesce(new.steel,0) <= 50)
      or coalesce(new.fuel,0) < 50 or (coalesce(old.fuel,0) > 50 and coalesce(new.fuel,0) <= 50)
      or coalesce(new.food,0) < 50 or (coalesce(old.food,0) > 50 and coalesce(new.food,0) <= 50)
      or coalesce(new.tech,0) < 50 or (coalesce(old.tech,0) > 50 and coalesce(new.tech,0) <= 50);
  end if;
  if aid_needed then new.humanitarian_last_at := now(); end if;
  new.credits := greatest(50, coalesce(new.credits,0));
  new.steel := greatest(50, coalesce(new.steel,0));
  new.fuel := greatest(50, coalesce(new.fuel,0));
  new.food := greatest(50, coalesce(new.food,0));
  new.tech := greatest(50, coalesce(new.tech,0));
  return new;
end;
$$;

-- Prevent purchasing a weaker tool over an active stronger tool.
create or replace function public.gw_buy_personal_item(p_player_id uuid, p_item text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  item text := lower(trim(p_item));
  price bigint;
  label text;
  next_home integer;
begin
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;

  if item in ('tool','инструмент','кирка') then
    if p.tool_tier >= 2 and p.tool_uses_left > 0 then
      raise exception 'Инструмент II ещё активен. Нельзя заменить его более слабым инструментом.';
    end if;
    price:=500; label:='Инструмент I';
  elsif item in ('pro_tool','проинструмент','профи','профинструмент') then
    price:=1200; label:='Инструмент II';
  elsif item in ('cooldown','сброс','эликсир') then price:=450; label:='Эликсир сброса';
  elsif item in ('boost','буст','усилитель') then price:=700; label:='Буст добычи';
  elsif item in ('home','дом') then
    next_home:=p.home_level+1;
    if next_home>3 then raise exception 'Дом уже максимального уровня.'; end if;
    price:=case next_home when 1 then 1600 when 2 then 4500 else 10000 end;
    label:='Дом ур.'||next_home;
  else raise exception 'Товар не найден. Используйте !магазин.';
  end if;

  if p.personal_coins < price then raise exception 'Недостаточно личных монет. Нужно %.', price; end if;
  update public.players set personal_coins=personal_coins-price where id=p_player_id;

  if item in ('tool','инструмент','кирка') then update public.players set tool_tier=1,tool_uses_left=25 where id=p_player_id;
  elsif item in ('pro_tool','проинструмент','профи','профинструмент') then update public.players set tool_tier=2,tool_uses_left=25 where id=p_player_id;
  elsif item in ('cooldown','сброс','эликсир') then update public.players set cooldown_elixirs=cooldown_elixirs+1 where id=p_player_id;
  elsif item in ('boost','буст','усилитель') then update public.players set gather_boost_elixirs=gather_boost_elixirs+1 where id=p_player_id;
  elsif item in ('home','дом') then update public.players set home_level=next_home,home_income_at=now() where id=p_player_id;
  end if;

  insert into public.personal_economy_log(player_id,action,payload)
  values(p_player_id,'buy',jsonb_build_object('item',item,'label',label,'price',price));
  return jsonb_build_object('item',item,'label',label,'price',price);
end;
$$;

-- Noble titles may only move upward; buying a lower/equal title must not burn coins.
create or replace function public.gw_buy_noble_title(p_player_id uuid, p_title text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  key text := lower(trim(p_title));
  title text;
  price bigint;
  requested_rank integer;
  current_rank integer := 0;
begin
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;

  if key in ('барон','baron') then title:='Барон';price:=3500;requested_rank:=1;
  elsif key in ('граф','count') then title:='Граф';price:=12000;requested_rank:=2;
  elsif key in ('магнат','magnate') then title:='Магнат';price:=30000;requested_rank:=3;
  else raise exception 'Титулы: Барон, Граф, Магнат.'; end if;

  current_rank := case p.noble_title when 'Барон' then 1 when 'Граф' then 2 when 'Магнат' then 3 else 0 end;
  if current_rank >= requested_rank then
    raise exception 'У вас уже этот или более высокий дворянский титул.';
  end if;
  if p.personal_coins<price then raise exception 'Недостаточно личных монет. Нужно %.',price; end if;

  update public.players set personal_coins=personal_coins-price,noble_title=title where id=p_player_id;
  insert into public.personal_economy_log(player_id,action,payload)
  values(p_player_id,'title',jsonb_build_object('title',title,'price',price));
  return jsonb_build_object('title',title,'price',price);
end;
$$;

create or replace function public.gw_invest_glory(p_player_id uuid, p_state_id uuid, p_amount bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  elo integer;
  spend bigint;
  remaining bigint;
begin
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_player_id) then
    raise exception 'Вы не гражданин этого государства.';
  end if;
  if p.glory_invested_date<>current_date then
    update public.players set glory_invested_today=0,glory_invested_date=current_date where id=p_player_id returning * into p;
  end if;
  if p_amount<250 then raise exception 'Минимальная инвестиция — 250 монет.'; end if;
  remaining:=greatest(0,5000-p.glory_invested_today);
  if remaining<250 then raise exception 'Дневной лимит инвестиций исчерпан.'; end if;
  spend:=least(p_amount,remaining);
  elo:=floor(spend/250)::integer;
  spend:=elo::bigint*250;
  if p.personal_coins<spend then raise exception 'Недостаточно личных монет.'; end if;
  update public.players set personal_coins=personal_coins-spend,glory_invested_today=glory_invested_today+spend where id=p_player_id;
  update public.states set rating=rating+elo,rating_peak=greatest(rating_peak,rating+elo) where id=p_state_id;
  insert into public.personal_economy_log(player_id,state_id,action,payload)
  values(p_player_id,p_state_id,'glory',jsonb_build_object('coins',spend,'elo',elo));
  return jsonb_build_object('coins',spend,'elo',elo,'dailyRemaining',remaining-spend);
end;
$$;

create or replace function public.gw_wild_raid(p_player_id uuid, p_state_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  duty text;
  success boolean;
  resource text;
  amount integer := 0;
  remaining integer;
begin
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  select duty_role into duty from public.state_members where state_id=p_state_id and player_id=p_player_id;
  if not found then raise exception 'Вы не гражданин этого государства.'; end if;
  if duty<>'spy' then raise exception 'Команда доступна только Шпиону.'; end if;
  if p.last_wild_raid_at is not null and p.last_wild_raid_at+interval '2 hours'>now() then
    remaining:=ceil(extract(epoch from ((p.last_wild_raid_at+interval '2 hours')-now()))/60)::integer;
    raise exception 'Следующий набег доступен через % мин.',greatest(1,remaining);
  end if;
  success:=random()<.15;
  update public.players set last_wild_raid_at=now() where id=p_player_id;
  if success then
    resource:=(array['steel','fuel','food','tech'])[1+floor(random()*4)::integer];
    amount:=8+floor(random()*17)::integer;
    if resource='steel' then update public.players set inventory_steel=inventory_steel+amount where id=p_player_id;
    elsif resource='fuel' then update public.players set inventory_fuel=inventory_fuel+amount where id=p_player_id;
    elsif resource='food' then update public.players set inventory_food=inventory_food+amount where id=p_player_id;
    else update public.players set inventory_tech=inventory_tech+amount where id=p_player_id; end if;
  end if;
  insert into public.personal_economy_log(player_id,state_id,action,payload)
  values(p_player_id,p_state_id,'wild_raid',jsonb_build_object('success',success,'resource',resource,'amount',amount));
  return jsonb_build_object('success',success,'resource',resource,'amount',amount);
end;
$$;

-- Keep the corrected functions server-only even on projects upgraded from older snapshots.
revoke all on function public.gw_buy_personal_item(uuid,text) from public,anon,authenticated;
revoke all on function public.gw_buy_noble_title(uuid,text) from public,anon,authenticated;
revoke all on function public.gw_invest_glory(uuid,uuid,bigint) from public,anon,authenticated;
revoke all on function public.gw_wild_raid(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gw_buy_personal_item(uuid,text) to service_role;
grant execute on function public.gw_buy_noble_title(uuid,text) to service_role;
grant execute on function public.gw_invest_glory(uuid,uuid,bigint) to service_role;
grant execute on function public.gw_wild_raid(uuid,uuid) to service_role;


-- Let the resource-floor trigger own humanitarian timestamps. v5.4.0 also
-- wrote humanitarian_last_at from OLD row values inside gw_tick_state, which
-- refreshed the timestamp forever while any resource merely stayed at 50.
create or replace function public.gw_tick_state(
  p_state_id uuid,
  p_credits_rate integer,
  p_steel_rate integer,
  p_fuel_rate integer,
  p_food_rate integer,
  p_tech_rate integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.states%rowtype;
  elapsed_hours numeric;
  multiplier numeric := 1.0;
  levels integer := 0;
  military_levels integer := 0;
  upkeep_credits bigint := 0;
  upkeep_food bigint := 0;
  upkeep_fuel bigint := 0;
  should_sleep boolean := false;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;

  if s.destroyed_until is not null and s.destroyed_until > now() then multiplier:=.25;
  elsif s.destroyed_until is not null and s.destroyed_until <= now() then
    update public.states set destroyed_until=null,island_integrity=greatest(island_integrity,55) where id=p_state_id returning * into s;
    multiplier:=greatest(.55,s.island_integrity/100.0);
  else multiplier:=greatest(.55,s.island_integrity/100.0); end if;

  elapsed_hours:=least(6.0,greatest(0.0,extract(epoch from(now()-s.last_tick_at))/3600.0));
  if elapsed_hours>=.02 then
    select coalesce(sum(level),0),coalesce(sum(level) filter(where building_type in ('barracks','outpost','refinery')),0)
      into levels,military_levels from public.buildings where state_id=p_state_id;
    upkeep_credits:=floor(levels*6*elapsed_hours);
    upkeep_food:=floor(levels*1.8*elapsed_hours);
    upkeep_fuel:=floor(military_levels*1.2*elapsed_hours);

    if not s.economy_sleeping and (s.credits-upkeep_credits<50 or s.food-upkeep_food<50 or s.fuel-upkeep_fuel<50) then should_sleep:=true;
    else should_sleep:=s.economy_sleeping; end if;

    update public.states set
      credits=greatest(50, credits + floor(p_credits_rate*elapsed_hours*multiplier*(case when should_sleep then .20 else 1 end))::bigint - case when should_sleep then 0 else upkeep_credits end),
      steel=greatest(50, steel + floor(p_steel_rate*elapsed_hours*multiplier)::bigint),
      fuel=greatest(50, fuel + floor(p_fuel_rate*elapsed_hours*multiplier)::bigint - case when should_sleep then 0 else upkeep_fuel end),
      food=greatest(50, food + floor(p_food_rate*elapsed_hours*multiplier)::bigint - case when should_sleep then 0 else upkeep_food end),
      tech=greatest(50, tech + floor(p_tech_rate*elapsed_hours*multiplier)::bigint),
      economy_sleeping=should_sleep,
      last_tick_at=now()
    where id=p_state_id returning * into s;
  end if;
  return to_jsonb(s);
end;
$$;


-- Trigger-only SECURITY DEFINER helpers must not be directly executable by clients.
revoke all on function public.gw_touch_election() from public,anon,authenticated;
revoke all on function public.gw_place_island() from public,anon,authenticated;
revoke all on function public.gw_sync_freeport_population() from public,anon,authenticated;
