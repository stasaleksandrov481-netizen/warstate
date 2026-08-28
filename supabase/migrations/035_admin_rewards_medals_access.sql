-- WARSTATE v5.1: project-admin rewards, medals, group access and live boost effects.

alter table public.states add column if not exists telegram_chat_username text;
alter table public.states add column if not exists achievement_points bigint not null default 0 check (achievement_points >= 0);
alter table public.states add column if not exists admin_army_boost_pct integer not null default 0 check (admin_army_boost_pct between 0 and 300);
alter table public.states add column if not exists admin_army_boost_until timestamptz;
alter table public.states add column if not exists admin_threat_shield_until timestamptz;
alter table public.states add column if not exists admin_xp_boost_pct integer not null default 0 check (admin_xp_boost_pct between 0 and 300);
alter table public.states add column if not exists admin_xp_boost_until timestamptz;

alter table public.players add column if not exists admin_title text;

create table if not exists public.player_medals (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  state_id uuid references public.states(id) on delete set null,
  icon text not null default '◆',
  title text not null,
  description text not null default '',
  awarded_by_telegram_id bigint not null,
  awarded_by_username text,
  awarded_at timestamptz not null default now()
);
create index if not exists idx_player_medals_player on public.player_medals(player_id, awarded_at desc);

create table if not exists public.state_medals (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  icon text not null default '◆',
  title text not null,
  description text not null default '',
  awarded_by_telegram_id bigint not null,
  awarded_by_username text,
  awarded_at timestamptz not null default now()
);
create index if not exists idx_state_medals_state on public.state_medals(state_id, awarded_at desc);

create table if not exists public.admin_reward_log (
  id uuid primary key default gen_random_uuid(),
  admin_telegram_id bigint not null,
  admin_username text,
  state_id uuid not null references public.states(id) on delete cascade,
  player_id uuid references public.players(id) on delete set null,
  action_type text not null check (action_type in ('reward','message')),
  reward_type text,
  amount bigint not null default 0,
  parameters jsonb not null default '{}'::jsonb,
  reason text,
  message_text text,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_reward_log_state on public.admin_reward_log(state_id, created_at desc);
create index if not exists idx_admin_reward_log_admin on public.admin_reward_log(admin_telegram_id, created_at desc);

create table if not exists public.admin_chat_access_requests (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  admin_telegram_id bigint not null,
  admin_username text,
  request_message_id bigint not null,
  status text not null default 'pending' check (status in ('pending','fulfilled','cancelled')),
  invite_link text,
  requested_at timestamptz not null default now(),
  fulfilled_at timestamptz
);
create index if not exists idx_admin_chat_access_pending on public.admin_chat_access_requests(state_id, request_message_id, status);

alter table public.player_medals enable row level security;
alter table public.state_medals enable row level security;
alter table public.admin_reward_log enable row level security;
alter table public.admin_chat_access_requests enable row level security;
-- No anon/authenticated policies: these tables are served through authenticated Vercel routes.

-- Apply a state-wide XP multiplier to every positive XP delta while the admin boost is active.
create or replace function public.gw_apply_admin_xp_boost()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  boost_pct integer := 0;
  boosted_delta bigint := 0;
begin
  if new.xp <= old.xp then return new; end if;
  select case when s.admin_xp_boost_until > now() then greatest(0,s.admin_xp_boost_pct) else 0 end
    into boost_pct
  from public.states s
  where s.id = new.home_state_id;
  if coalesce(boost_pct,0) <= 0 then return new; end if;
  boosted_delta := greatest(0,new.xp-old.xp) + round(greatest(0,new.xp-old.xp) * boost_pct / 100.0)::bigint;
  new.xp := old.xp + boosted_delta;
  new.level := greatest(coalesce(new.level,1), 1 + floor(sqrt(greatest(0,new.xp) / 180.0))::integer);
  return new;
end;
$$;

drop trigger if exists trg_gw_admin_xp_boost on public.players;
create trigger trg_gw_admin_xp_boost
before update of xp on public.players
for each row execute function public.gw_apply_admin_xp_boost();

-- Re-define the battle preparation trigger so temporary admin army boosts alter real battle power.
create or replace function public.gw_prepare_battle_strategy()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  a public.states%rowtype;
  d public.states%rowtype;
  ratio numeric := 1;
  size_log numeric := 0;
  recent_attacks integer := 0;
  aggr numeric := 0;
  rep_bonus numeric := 0;
  seed bigint;
  army_boost numeric := 1;
begin
  if new.battle_kind <> 'island' or new.defender_state_id is null then return new; end if;
  select * into a from public.gw_refresh_state_strategy(new.attacker_state_id);
  select * into d from public.gw_refresh_state_strategy(new.defender_state_id);

  if a.is_beginner_island then raise exception 'Атаки из учебного округа запрещены.'; end if;
  if d.is_beginner_island then raise exception 'Учебный округ находится под защитой.'; end if;

  ratio := greatest(0.0001,a.state_size/greatest(0.0001,d.state_size));
  size_log := greatest(0,ln(ratio)/ln(2.0));
  select count(*)::integer into recent_attacks from public.battles where attacker_state_id=a.id and created_at>=now()-interval '7 days';
  aggr := case when recent_attacks>=3 then least(0.15,(recent_attacks-2)*0.05) else 0 end;
  rep_bonus := greatest(0,least(0.12,d.reputation/5000.0));
  seed := floor(random()*900000000000000000)::bigint + 1000000;
  army_boost := case when a.admin_army_boost_until > now() then 1 + greatest(0,a.admin_army_boost_pct)/100.0 else 1 end;

  new.attacker_state_size := a.state_size;
  new.defender_state_size := d.state_size;
  new.attacker_size_modifier := round(1-least(0.30,0.08*size_log),4);
  new.defender_size_modifier := round(1+least(0.25,0.07*size_log),4);
  new.underdog_bonus := round(least(0.25,0.07*size_log),4);
  new.aggression_penalty := round(aggr,4);
  new.defense_buffer_pct := round(least(0.20,d.defense_buffer_base+rep_bonus),4);
  new.attacker_raw_power := greatest(1,round(a.army_power*army_boost));
  new.defender_raw_power := d.defense_power;
  new.random_seed := seed;
  new.attacker_random_modifier := round((0.85+random()*0.30)::numeric,4);
  new.defender_random_modifier := round((0.85+random()*0.30)::numeric,4);
  new.attacker_final_power := greatest(1,round((a.army_power*army_boost)*new.attacker_size_modifier*(1-new.aggression_penalty)*new.attacker_random_modifier));
  new.defender_final_power := greatest(1,round((d.defense_power*new.defender_size_modifier*(1+new.defense_buffer_pct))*new.defender_random_modifier));
  return new;
end;
$$;

-- All core reward effects and the audit row are committed together.
create or replace function public.gw_admin_apply_reward(
  p_admin_telegram_id bigint,
  p_admin_username text,
  p_state_id uuid,
  p_player_id uuid,
  p_reward_type text,
  p_amount bigint,
  p_parameters jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  s public.states%rowtype;
  resource_key text := lower(coalesce(p_parameters->>'resource','credits'));
  duration_hours integer := greatest(1,least(720,coalesce((p_parameters->>'durationHours')::integer,24)));
  boost_pct integer := greatest(1,least(300,coalesce((p_parameters->>'boostPct')::integer,25)));
  target_scope text := lower(coalesce(p_parameters->>'targetScope','state'));
  medal_id uuid;
  result_label text;
begin
  select * into s from public.states where id=p_state_id for update;
  if s.id is null or coalesce(s.is_freeport,false) then raise exception 'Государство не найдено.'; end if;

  if p_reward_type='resource' then
    if resource_key not in ('credits','steel','fuel','food','tech') then raise exception 'Неизвестный ресурс.'; end if;
    if p_amount <= 0 then raise exception 'Сумма должна быть больше нуля.'; end if;
    execute format('update public.states set %I=%I+$1 where id=$2',resource_key,resource_key) using p_amount,p_state_id;
    result_label := resource_key||' +'||p_amount;
  elsif p_reward_type='military_boost' then
    update public.states set
      admin_army_boost_pct=case when admin_army_boost_until>now() then greatest(admin_army_boost_pct,boost_pct) else boost_pct end,
      admin_army_boost_until=greatest(coalesce(admin_army_boost_until,now()),now()+make_interval(hours=>duration_hours))
    where id=p_state_id;
    result_label := '+'||boost_pct||'% к армии · '||duration_hours||' ч';
  elsif p_reward_type='protection' then
    update public.states set admin_threat_shield_until=greatest(coalesce(admin_threat_shield_until,now()),now()+make_interval(hours=>duration_hours)) where id=p_state_id;
    update public.state_threat_events set status='resolved',resolved_at=now(),resolution_action='admin_shield' where state_id=p_state_id and status='open';
    result_label := 'щит от ЧП · '||duration_hours||' ч';
  elsif p_reward_type='prestige' then
    if p_amount <= 0 then raise exception 'Сумма престижа должна быть больше нуля.'; end if;
    update public.states set achievement_points=achievement_points+p_amount where id=p_state_id;
    result_label := '+'||p_amount||' престижа';
  elsif p_reward_type='title' then
    if p_player_id is null then raise exception 'Для титула выберите игрока.'; end if;
    if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_player_id) then raise exception 'Игрок не состоит в выбранном государстве.'; end if;
    update public.players set admin_title=left(nullif(trim(p_parameters->>'title'),''),80) where id=p_player_id;
    if not exists(select 1 from public.players where id=p_player_id and admin_title is not null) then raise exception 'Укажите название титула.'; end if;
    result_label := 'титул · '||(select admin_title from public.players where id=p_player_id);
  elsif p_reward_type='medal' then
    if nullif(trim(p_parameters->>'title'),'') is null then raise exception 'Укажите название медали.'; end if;
    if target_scope='player' then
      if p_player_id is null then raise exception 'Выберите игрока для медали.'; end if;
      if not exists(select 1 from public.state_members where state_id=p_state_id and player_id=p_player_id) then raise exception 'Игрок не состоит в выбранном государстве.'; end if;
      insert into public.player_medals(player_id,state_id,icon,title,description,awarded_by_telegram_id,awarded_by_username)
      values(p_player_id,p_state_id,left(coalesce(nullif(trim(p_parameters->>'icon'),''),'◆'),500),left(trim(p_parameters->>'title'),100),left(coalesce(p_parameters->>'description',''),500),p_admin_telegram_id,nullif(trim(p_admin_username),''))
      returning id into medal_id;
      result_label := 'медаль игроку · '||trim(p_parameters->>'title');
    else
      insert into public.state_medals(state_id,icon,title,description,awarded_by_telegram_id,awarded_by_username)
      values(p_state_id,left(coalesce(nullif(trim(p_parameters->>'icon'),''),'◆'),500),left(trim(p_parameters->>'title'),100),left(coalesce(p_parameters->>'description',''),500),p_admin_telegram_id,nullif(trim(p_admin_username),''))
      returning id into medal_id;
      result_label := 'медаль государству · '||trim(p_parameters->>'title');
    end if;
  elsif p_reward_type='treasury' then
    if p_amount <= 0 then raise exception 'Сумма должна быть больше нуля.'; end if;
    update public.states set credits=credits+p_amount where id=p_state_id;
    result_label := 'казна +'||p_amount;
  elsif p_reward_type='xp_boost' then
    update public.states set
      admin_xp_boost_pct=case when admin_xp_boost_until>now() then greatest(admin_xp_boost_pct,boost_pct) else boost_pct end,
      admin_xp_boost_until=greatest(coalesce(admin_xp_boost_until,now()),now()+make_interval(hours=>duration_hours))
    where id=p_state_id;
    result_label := '+'||boost_pct||'% XP · '||duration_hours||' ч';
  elsif p_reward_type='starter_pack' then
    update public.states set credits=credits+5000,steel=steel+1000,fuel=fuel+750,food=food+1500,tech=tech+250,
      admin_threat_shield_until=greatest(coalesce(admin_threat_shield_until,now()),now()+interval '12 hours') where id=p_state_id;
    result_label := '5000 кредитов · 1000 стали · 750 топлива · 1500 еды · 250 технологий · щит 12 ч';
  elsif p_reward_type='reputation' then
    if p_amount <= 0 then raise exception 'Сумма должна быть больше нуля.'; end if;
    update public.states set reputation=least(1000,reputation+p_amount::integer) where id=p_state_id;
    result_label := '+'||p_amount||' репутации';
  elsif p_reward_type='influence' then
    if p_amount <= 0 then raise exception 'Сумма должна быть больше нуля.'; end if;
    update public.states set influence=influence+p_amount where id=p_state_id;
    result_label := '+'||p_amount||' влияния';
  else
    raise exception 'Неизвестный тип награды.';
  end if;

  insert into public.admin_reward_log(admin_telegram_id,admin_username,state_id,player_id,action_type,reward_type,amount,parameters,reason)
  values(p_admin_telegram_id,nullif(trim(p_admin_username),''),p_state_id,p_player_id,'reward',p_reward_type,coalesce(p_amount,0),coalesce(p_parameters,'{}'::jsonb),nullif(left(trim(coalesce(p_reason,'')),500),''));

  return jsonb_build_object('ok',true,'label',result_label,'medalId',medal_id);
end;
$$;
revoke all on function public.gw_admin_apply_reward(bigint,text,uuid,uuid,text,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.gw_admin_apply_reward(bigint,text,uuid,uuid,text,bigint,jsonb,text) to service_role;
