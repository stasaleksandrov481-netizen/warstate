-- WARSTATE v5.4: closed personal/state economy, role gathering and anti-softlock.

alter table public.players add column if not exists personal_coins bigint not null default 500 check (personal_coins >= 0);
alter table public.players add column if not exists inventory_steel bigint not null default 0 check (inventory_steel >= 0);
alter table public.players add column if not exists inventory_fuel bigint not null default 0 check (inventory_fuel >= 0);
alter table public.players add column if not exists inventory_food bigint not null default 0 check (inventory_food >= 0);
alter table public.players add column if not exists inventory_tech bigint not null default 0 check (inventory_tech >= 0);
alter table public.players add column if not exists last_gather_at timestamptz;
alter table public.players add column if not exists last_wild_raid_at timestamptz;
alter table public.players add column if not exists tool_tier integer not null default 0 check (tool_tier between 0 and 2);
alter table public.players add column if not exists tool_uses_left integer not null default 0 check (tool_uses_left between 0 and 25);
alter table public.players add column if not exists home_level integer not null default 0 check (home_level between 0 and 3);
alter table public.players add column if not exists home_income_at timestamptz not null default now();
alter table public.players add column if not exists gather_boost_until timestamptz;
alter table public.players add column if not exists cooldown_elixirs integer not null default 0 check (cooldown_elixirs >= 0);
alter table public.players add column if not exists gather_boost_elixirs integer not null default 0 check (gather_boost_elixirs >= 0);
alter table public.players add column if not exists noble_title text;
alter table public.players add column if not exists glory_invested_today bigint not null default 0 check (glory_invested_today >= 0);
alter table public.players add column if not exists glory_invested_date date not null default current_date;

alter table public.states add column if not exists economy_sleeping boolean not null default false;
alter table public.states add column if not exists humanitarian_last_at timestamptz;

-- Hard anti-softlock floor. Any state resource mutation, including repairs,
-- construction, espionage and legacy code paths, is clamped to the humanitarian reserve.
create or replace function public.gw_enforce_state_resource_floor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.credits,0) < 50 or coalesce(new.steel,0) < 50 or coalesce(new.fuel,0) < 50 or coalesce(new.food,0) < 50 or coalesce(new.tech,0) < 50 then
    new.humanitarian_last_at := now();
  end if;
  new.credits := greatest(50, coalesce(new.credits,0));
  new.steel := greatest(50, coalesce(new.steel,0));
  new.fuel := greatest(50, coalesce(new.fuel,0));
  new.food := greatest(50, coalesce(new.food,0));
  new.tech := greatest(50, coalesce(new.tech,0));
  return new;
end;
$$;

drop trigger if exists trg_gw_state_resource_floor_insert on public.states;
create trigger trg_gw_state_resource_floor_insert
before insert on public.states
for each row execute function public.gw_enforce_state_resource_floor();

drop trigger if exists trg_gw_state_resource_floor_update on public.states;
create trigger trg_gw_state_resource_floor_update
before update of credits,steel,fuel,food,tech on public.states
for each row execute function public.gw_enforce_state_resource_floor();

update public.states
set credits=greatest(50,credits),
    steel=greatest(50,steel),
    fuel=greatest(50,fuel),
    food=greatest(50,food),
    tech=greatest(50,tech)
where credits<50 or steel<50 or fuel<50 or food<50 or tech<50;

create table if not exists public.personal_economy_log (
  id bigserial primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  state_id uuid references public.states(id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_personal_economy_log_player on public.personal_economy_log(player_id, created_at desc);
create index if not exists idx_personal_economy_log_state on public.personal_economy_log(state_id, created_at desc);
alter table public.personal_economy_log enable row level security;

create or replace function public.gw_collect_home_income(p_player_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  whole_hours integer;
  hourly_rate integer;
  credited bigint := 0;
begin
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;

  hourly_rate := case p.home_level when 1 then 35 when 2 then 90 when 3 then 180 else 0 end;
  if hourly_rate <= 0 then
    update public.players set home_income_at=now() where id=p_player_id and home_income_at is null;
    return 0;
  end if;

  whole_hours := least(72, greatest(0, floor(extract(epoch from (now() - coalesce(p.home_income_at, now()))) / 3600)::integer));
  if whole_hours > 0 then
    credited := whole_hours::bigint * hourly_rate::bigint;
    update public.players
      set personal_coins=personal_coins+credited,
          home_income_at=coalesce(home_income_at, now()) + make_interval(hours => whole_hours)
      where id=p_player_id;
    insert into public.personal_economy_log(player_id, action, payload)
      values(p_player_id, 'home_income', jsonb_build_object('hours',whole_hours,'coins',credited));
  end if;
  return credited;
end;
$$;

create or replace function public.gw_personal_economy_snapshot(p_player_id uuid, p_state_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  duty text;
  sleeping boolean := false;
  home_credit bigint;
  cooldown_seconds integer;
begin
  home_credit := public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id;
  if not found then raise exception 'Игрок не найден.'; end if;
  select duty_role into duty from public.state_members where state_id=p_state_id and player_id=p_player_id limit 1;
  select coalesce(economy_sleeping,false) into sleeping from public.states where id=p_state_id;
  cooldown_seconds := greatest(0, ceil(extract(epoch from ((coalesce(p.last_gather_at, now() - interval '2 hours') + interval '2 hours') - now())))::integer);

  return jsonb_build_object(
    'coins', p.personal_coins,
    'inventory', jsonb_build_object('steel',p.inventory_steel,'fuel',p.inventory_fuel,'food',p.inventory_food,'tech',p.inventory_tech),
    'dutyRole', duty,
    'gatherCooldownSeconds', cooldown_seconds,
    'toolTier', p.tool_tier,
    'toolUsesLeft', p.tool_uses_left,
    'homeLevel', p.home_level,
    'homeHourlyCoins', case p.home_level when 1 then 35 when 2 then 90 when 3 then 180 else 0 end,
    'homeIncomeCollected', home_credit,
    'gatherBoostUntil', p.gather_boost_until,
    'cooldownElixirs', p.cooldown_elixirs,
    'gatherBoostElixirs', p.gather_boost_elixirs,
    'nobleTitle', p.noble_title,
    'economySleeping', sleeping
  );
end;
$$;

create or replace function public.gw_personal_gather(p_player_id uuid, p_state_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  duty text;
  sleeping boolean := false;
  hq_level integer := 0;
  mine_level integer := 0;
  refinery_level integer := 0;
  farm_level integer := 0;
  lab_level integer := 0;
  steel_gain integer := 0;
  fuel_gain integer := 0;
  food_gain integer := 0;
  tech_gain integer := 0;
  all_mult numeric := 1.0;
  tool_mult numeric := 1.0;
  uses_after integer := 0;
  remaining integer;
begin
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  select duty_role into duty from public.state_members where state_id=p_state_id and player_id=p_player_id;
  if not found then raise exception 'Вы не гражданин этого государства.'; end if;

  if p.last_gather_at is not null and p.last_gather_at + interval '2 hours' > now() then
    remaining := ceil(extract(epoch from ((p.last_gather_at + interval '2 hours') - now())) / 60)::integer;
    raise exception 'Добыча будет доступна через % мин. Используйте эликсир сброса из !магазин.', greatest(1,remaining);
  end if;

  select coalesce(economy_sleeping,false) into sleeping from public.states where id=p_state_id;
  if not sleeping then
    select
      coalesce(max(level) filter(where building_type='hq'),0),
      coalesce(max(level) filter(where building_type='mine'),0),
      coalesce(max(level) filter(where building_type='refinery'),0),
      coalesce(max(level) filter(where building_type='farm'),0),
      coalesce(max(level) filter(where building_type='lab'),0)
    into hq_level,mine_level,refinery_level,farm_level,lab_level
    from public.buildings where state_id=p_state_id;
  end if;

  if duty='miner' then steel_gain:=32; fuel_gain:=14;
  elsif duty='worker' then food_gain:=28; steel_gain:=14;
  elsif duty='spy' then tech_gain:=22; steel_gain:=4;
  elsif duty='diplomat' then tech_gain:=18; food_gain:=4;
  else steel_gain:=8; food_gain:=8; tech_gain:=2;
  end if;

  all_mult := 1.0 + hq_level * 0.015;
  tool_mult := case p.tool_tier when 1 then 1.20 when 2 then 1.35 else 1.0 end;
  if p.gather_boost_until is not null and p.gather_boost_until > now() then tool_mult := tool_mult * 1.50; end if;

  steel_gain := greatest(0, floor(steel_gain * all_mult * (1 + mine_level * .05) * tool_mult));
  fuel_gain := greatest(0, floor(fuel_gain * all_mult * (1 + refinery_level * .05) * tool_mult));
  food_gain := greatest(0, floor(food_gain * all_mult * (1 + farm_level * .05) * tool_mult));
  tech_gain := greatest(0, floor(tech_gain * all_mult * (1 + lab_level * .05) * tool_mult));

  uses_after := case when p.tool_tier > 0 and p.tool_uses_left > 0 then p.tool_uses_left - 1 else p.tool_uses_left end;
  update public.players set
    inventory_steel=inventory_steel+steel_gain,
    inventory_fuel=inventory_fuel+fuel_gain,
    inventory_food=inventory_food+food_gain,
    inventory_tech=inventory_tech+tech_gain,
    last_gather_at=now(),
    tool_uses_left=greatest(0,uses_after),
    tool_tier=case when p.tool_tier>0 and uses_after<=0 then 0 else p.tool_tier end
  where id=p_player_id;

  insert into public.personal_economy_log(player_id,state_id,action,payload)
    values(p_player_id,p_state_id,'gather',jsonb_build_object('role',duty,'steel',steel_gain,'fuel',fuel_gain,'food',food_gain,'tech',tech_gain,'sleeping',sleeping));

  return jsonb_build_object('steel',steel_gain,'fuel',fuel_gain,'food',food_gain,'tech',tech_gain,'role',duty,'toolUsesLeft',greatest(0,uses_after),'economySleeping',sleeping);
end;
$$;

create or replace function public.gw_sell_personal_resource(p_player_id uuid, p_state_id uuid, p_resource text, p_amount bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  duty text;
  trade_level integer := 0;
  base_price numeric;
  multiplier numeric := 1.0;
  coins bigint;
  resource_key text := lower(trim(p_resource));
  sleeping boolean := false;
begin
  if p_amount <= 0 then raise exception 'Количество должно быть больше нуля.'; end if;
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  select duty_role into duty from public.state_members where state_id=p_state_id and player_id=p_player_id;
  if not found then raise exception 'Вы не гражданин этого государства.'; end if;
  select coalesce(economy_sleeping,false) into sleeping from public.states where id=p_state_id for update;
  if not sleeping then select coalesce(max(level),0) into trade_level from public.buildings where state_id=p_state_id and building_type='trade_chamber'; end if;

  if resource_key in ('steel','сталь') then
    if p.inventory_steel < p_amount then raise exception 'Недостаточно стали в личном инвентаре.'; end if;
    base_price:=4; update public.players set inventory_steel=inventory_steel-p_amount where id=p_player_id;
    update public.states set steel=steel+p_amount,economy_sleeping=false where id=p_state_id;
    resource_key:='steel';
  elsif resource_key in ('fuel','топливо') then
    if p.inventory_fuel < p_amount then raise exception 'Недостаточно топлива в личном инвентаре.'; end if;
    base_price:=6; update public.players set inventory_fuel=inventory_fuel-p_amount where id=p_player_id;
    update public.states set fuel=fuel+p_amount,economy_sleeping=false where id=p_state_id;
    resource_key:='fuel';
  elsif resource_key in ('food','еда') then
    if p.inventory_food < p_amount then raise exception 'Недостаточно еды в личном инвентаре.'; end if;
    base_price:=3; update public.players set inventory_food=inventory_food-p_amount where id=p_player_id;
    update public.states set food=food+p_amount,economy_sleeping=false where id=p_state_id;
    resource_key:='food';
  elsif resource_key in ('tech','тех','технологии') then
    if p.inventory_tech < p_amount then raise exception 'Недостаточно Tech в личном инвентаре.'; end if;
    base_price:=10; update public.players set inventory_tech=inventory_tech-p_amount where id=p_player_id;
    update public.states set tech=tech+p_amount,economy_sleeping=false where id=p_state_id;
    resource_key:='tech';
  else raise exception 'Ресурс: сталь, топливо, еда или tech.';
  end if;

  multiplier := 1.0 + trade_level * .02 + case when duty='diplomat' then .10 else 0 end;
  coins := greatest(1, floor(p_amount * base_price * multiplier));
  update public.players set personal_coins=personal_coins+coins where id=p_player_id;
  update public.state_members set contribution=contribution+greatest(1::bigint,p_amount/10) where state_id=p_state_id and player_id=p_player_id;
  insert into public.personal_economy_log(player_id,state_id,action,payload)
    values(p_player_id,p_state_id,'sell',jsonb_build_object('resource',resource_key,'amount',p_amount,'coins',coins,'multiplier',multiplier));
  return jsonb_build_object('resource',resource_key,'amount',p_amount,'coins',coins,'multiplier',multiplier,'wokeEconomy',sleeping);
end;
$$;

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

  if item in ('tool','инструмент','кирка') then price:=500; label:='Инструмент I';
  elsif item in ('pro_tool','проинструмент','профи','профинструмент') then price:=1200; label:='Инструмент II';
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

  insert into public.personal_economy_log(player_id,action,payload) values(p_player_id,'buy',jsonb_build_object('item',item,'label',label,'price',price));
  return jsonb_build_object('item',item,'label',label,'price',price);
end;
$$;

create or replace function public.gw_use_personal_consumable(p_player_id uuid, p_item text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.players%rowtype;
  item text := lower(trim(p_item));
begin
  select * into p from public.players where id=p_player_id for update;
  if not found then raise exception 'Игрок не найден.'; end if;
  if item in ('cooldown','сброс','эликсир') then
    if p.cooldown_elixirs<=0 then raise exception 'Нет эликсира сброса. Купите его через !магазин.'; end if;
    update public.players set cooldown_elixirs=cooldown_elixirs-1,last_gather_at=now()-interval '2 hours' where id=p_player_id;
    return jsonb_build_object('item','cooldown','message','Таймер добычи сброшен.');
  elsif item in ('boost','буст','усилитель') then
    if p.gather_boost_elixirs<=0 then raise exception 'Нет буста добычи. Купите его через !магазин.'; end if;
    update public.players set gather_boost_elixirs=gather_boost_elixirs-1,gather_boost_until=greatest(coalesce(gather_boost_until,now()),now())+interval '2 hours' where id=p_player_id;
    return jsonb_build_object('item','boost','message','Буст добычи +50% активирован на 2 часа.');
  else raise exception 'Расходник: сброс или буст.';
  end if;
end;
$$;

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
begin
  perform public.gw_collect_home_income(p_player_id);
  select * into p from public.players where id=p_player_id for update;
  if key in ('барон','baron') then title:='Барон';price:=3500;
  elsif key in ('граф','count') then title:='Граф';price:=12000;
  elsif key in ('магнат','magnate') then title:='Магнат';price:=30000;
  else raise exception 'Титулы: Барон, Граф, Магнат.'; end if;
  if p.personal_coins<price then raise exception 'Недостаточно личных монет. Нужно %.',price; end if;
  update public.players set personal_coins=personal_coins-price,noble_title=title where id=p_player_id;
  insert into public.personal_economy_log(player_id,action,payload) values(p_player_id,'title',jsonb_build_object('title',title,'price',price));
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
  if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_player_id) then raise exception 'Вы не гражданин этого государства.'; end if;
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
  insert into public.personal_economy_log(player_id,state_id,action,payload) values(p_player_id,p_state_id,'glory',jsonb_build_object('coins',spend,'elo',elo));
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
  select duty_role into duty from public.state_members where state_id=p_state_id and player_id=p_player_id;
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
  insert into public.personal_economy_log(player_id,state_id,action,payload) values(p_player_id,p_state_id,'wild_raid',jsonb_build_object('success',success,'resource',resource,'amount',amount));
  return jsonb_build_object('success',success,'resource',resource,'amount',amount);
end;
$$;

-- State economy: raw resources enter primarily through citizens. Buildings consume upkeep.
-- When upkeep cannot be paid above the safety floor, infrastructure sleeps instead of being destroyed.
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
  aid_needed boolean := false;
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
      humanitarian_last_at=case when credits<=50 or steel<=50 or fuel<=50 or food<=50 or tech<=50 then now() else humanitarian_last_at end,
      last_tick_at=now()
    where id=p_state_id returning * into s;
  end if;
  return to_jsonb(s);
end;
$$;

revoke all on function public.gw_collect_home_income(uuid) from public,anon,authenticated;
revoke all on function public.gw_personal_economy_snapshot(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_personal_gather(uuid,uuid) from public,anon,authenticated;
revoke all on function public.gw_sell_personal_resource(uuid,uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.gw_buy_personal_item(uuid,text) from public,anon,authenticated;
revoke all on function public.gw_use_personal_consumable(uuid,text) from public,anon,authenticated;
revoke all on function public.gw_buy_noble_title(uuid,text) from public,anon,authenticated;
revoke all on function public.gw_invest_glory(uuid,uuid,bigint) from public,anon,authenticated;
revoke all on function public.gw_wild_raid(uuid,uuid) from public,anon,authenticated;

grant execute on function public.gw_collect_home_income(uuid) to service_role;
grant execute on function public.gw_personal_economy_snapshot(uuid,uuid) to service_role;
grant execute on function public.gw_personal_gather(uuid,uuid) to service_role;
grant execute on function public.gw_sell_personal_resource(uuid,uuid,text,bigint) to service_role;
grant execute on function public.gw_buy_personal_item(uuid,text) to service_role;
grant execute on function public.gw_use_personal_consumable(uuid,text) to service_role;
grant execute on function public.gw_buy_noble_title(uuid,text) to service_role;
grant execute on function public.gw_invest_glory(uuid,uuid,bigint) to service_role;
grant execute on function public.gw_wild_raid(uuid,uuid) to service_role;

-- Reserve-aware construction. The humanitarian floor is not spendable.
create or replace function public.gw_upgrade_building(
  p_state_id uuid,
  p_building_type text,
  p_credits bigint,
  p_steel bigint,
  p_fuel bigint,
  p_food bigint,
  p_tech bigint
) returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  s public.states%rowtype;
  b public.buildings%rowtype;
  max_building_level integer:=12;
  target_level integer;
  build_minutes integer;
begin
  if least(p_credits,p_steel,p_fuel,p_food,p_tech)<0 then raise exception 'Некорректная стоимость улучшения.'; end if;
  perform public.gw_finish_building_upgrades(p_state_id);
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  select * into b from public.buildings where state_id=p_state_id and building_type=p_building_type for update;
  if not found then raise exception 'Здание не найдено.'; end if;

  if s.is_beginner_island then
    max_building_level:=least(5,s.max_level);
    if p_building_type='barracks' then raise exception 'В учебном округе агрессивные улучшения запрещены.'; end if;
  end if;
  if b.upgrade_target_level is not null and b.upgrade_finishes_at>now() then raise exception 'Это здание уже улучшается.'; end if;
  if b.upgrade_cooldown_until is not null and b.upgrade_cooldown_until>now() then raise exception 'Здание ещё остывает после предыдущего улучшения.'; end if;
  if b.level>=max_building_level then raise exception 'Максимальный уровень здания достигнут.'; end if;
  if s.credits-p_credits<50 or s.steel-p_steel<50 or s.fuel-p_fuel<50 or s.food-p_food<50 or s.tech-p_tech<50 then
    raise exception 'Нельзя тратить гуманитарный резерв. После операции должно остаться минимум 50 единиц каждого ресурса.';
  end if;

  target_level:=b.level+1;
  build_minutes:=least(45,greatest(2,target_level*3));
  update public.states
  set credits=credits-p_credits,steel=steel-p_steel,fuel=fuel-p_fuel,food=food-p_food,tech=tech-p_tech
  where id=p_state_id;
  update public.buildings
  set upgrade_target_level=target_level,upgrade_started_at=now(),
      upgrade_finishes_at=now()+make_interval(mins=>build_minutes),updated_at=now()
  where id=b.id;
  return target_level;
end;
$$;
revoke all on function public.gw_upgrade_building(uuid,text,bigint,bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.gw_upgrade_building(uuid,text,bigint,bigint,bigint,bigint,bigint) to service_role;

-- Reserve-aware repair. Repairs cannot consume the emergency floor.
create or replace function public.gw_repair_island(
  p_state_id uuid,
  p_amount integer default 25
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  s public.states%rowtype;
  repair_amount integer;
  credits_cost bigint;
  steel_cost bigint;
begin
  select * into s from public.states where id=p_state_id for update;
  if not found then raise exception 'Государство не найдено.'; end if;
  if s.destroyed_until is not null and s.destroyed_until>now() then raise exception 'Государство восстанавливается после разрушения.'; end if;
  if exists(select 1 from public.battles where status in ('scheduled','active') and (attacker_state_id=p_state_id or defender_state_id=p_state_id)) then
    raise exception 'Нельзя проводить ремонт во время активного боя.';
  end if;
  if s.island_integrity>=100 then raise exception 'Оборона уже полностью восстановлена.'; end if;

  repair_amount:=least(greatest(p_amount,1),100-s.island_integrity);
  credits_cost:=repair_amount*24;
  steel_cost:=repair_amount*3;
  if s.credits-credits_cost<50 or s.steel-steel_cost<50 then
    raise exception 'Для ремонта нужен свободный запас сверх гуманитарного резерва 50: % кредитов и % стали.',credits_cost,steel_cost;
  end if;

  update public.states set credits=credits-credits_cost,steel=steel-steel_cost,island_integrity=least(100,island_integrity+repair_amount)
  where id=p_state_id returning * into s;
  return jsonb_build_object('integrity',s.island_integrity,'repaired',repair_amount,'creditsCost',credits_cost,'steelCost',steel_cost);
end;
$$;
revoke all on function public.gw_repair_island(uuid,integer) from public,anon,authenticated;
grant execute on function public.gw_repair_island(uuid,integer) to service_role;

-- Existing espionage respects the same reserve, preventing transfer inflation
-- when a target or attacker is close to the humanitarian floor.
create or replace function public.gw_resolve_spy_quest(
  p_quest_id uuid,
  p_player_id uuid,
  p_option text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  q public.spy_quests%rowtype;
  member public.state_members%rowtype;
  own_state public.states%rowtype;
  target public.states%rowtype;
  chance numeric;
  success boolean;
  stolen integer:=0;
  penalty integer:=0;
  available integer:=0;
  result jsonb;
begin
  select * into q from public.spy_quests where id=p_quest_id for update;
  if not found then raise exception 'Шпионский квест не найден.'; end if;
  if q.player_id<>p_player_id then raise exception 'Это не ваш шпионский квест.'; end if;
  if q.status<>'active' then raise exception 'Шпионский квест уже завершён.'; end if;
  if q.expires_at<=now() then
    update public.spy_quests set status='expired',resolved_at=now() where id=q.id;
    raise exception 'Время операции истекло.';
  end if;

  select * into member from public.state_members where state_id=q.state_id and player_id=p_player_id for update;
  if not found or member.duty_role<>'spy' then raise exception 'Специализация «Шпион» больше не активна.'; end if;
  select * into own_state from public.states where id=q.state_id for update;
  select * into target from public.states where id=q.target_state_id for update;
  if own_state.is_freeport or own_state.is_beginner_island then raise exception 'Из защищённой территории шпионские операции недоступны.'; end if;
  if target.is_freeport or target.is_beginner_island then raise exception 'Цель защищена от шпионских операций.'; end if;

  if q.quest_kind='recon' then
    if p_option not in ('silent','contact') then raise exception 'Неизвестный вариант разведки.'; end if;
    chance:=case when p_option='silent' then .82 else .62 end;
    success:=random()<chance;
    result:=jsonb_build_object(
      'kind','recon','success',success,'option',p_option,
      'army',case when success then target.army_power else round(target.army_power/25.0)*25 end,
      'defense',case when success then target.defense_power else round(target.defense_power/25.0)*25 end,
      'activePlayers',target.active_player_count,
      'integrity',target.island_integrity,
      'credits',case when success then target.credits else null end
    );
  else
    if p_option not in ('bribe','invoice') then raise exception 'Неизвестный вариант операции с казной.'; end if;
    chance:=case when p_option='bribe' then .68 else .54 end;
    success:=random()<chance;
    if success then
      available:=greatest(0,target.credits-50);
      stolen:=least(available,greatest(0,least(750,floor(target.credits*(case when p_option='bribe' then .012 else .022 end))::integer)));
      if stolen>0 then
        update public.states set credits=credits-stolen where id=target.id;
        update public.states set credits=credits+stolen,reputation=reputation+1 where id=own_state.id;
      end if;
    else
      penalty:=least(60,greatest(0,own_state.credits-50));
      update public.states set credits=credits-penalty,reputation=greatest(0,reputation-2) where id=own_state.id;
    end if;
    result:=jsonb_build_object('kind','treasury','success',success,'option',p_option,'stolen',stolen,'penalty',penalty);
  end if;

  update public.spy_quests set status='resolved',result=result,resolved_at=now() where id=q.id;
  if success then
    update public.state_members set contribution=contribution+case when q.quest_kind='treasury' then 8 else 4 end where id=member.id;
    insert into public.contribution_events(player_id,state_id,source,amount,metadata)
    values(p_player_id,q.state_id,'spy',case when q.quest_kind='treasury' then 8 else 4 end,result);
  end if;
  return result;
end;
$$;
revoke all on function public.gw_resolve_spy_quest(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gw_resolve_spy_quest(uuid,uuid,text) to service_role;
