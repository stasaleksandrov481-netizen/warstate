-- GROUP WARS v0.8 / seasons, state identity and elections

alter table public.states add column if not exists motto text not null default 'Сила в единстве';
alter table public.states add column if not exists emblem text not null default '◆';
alter table public.states add column if not exists theme text not null default 'violet';

create table if not exists public.state_elections (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  status text not null default 'open' check (status in ('open','resolved','cancelled')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_by_player_id uuid references public.players(id) on delete set null,
  winner_player_id uuid references public.players(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_state_open_election
  on public.state_elections(state_id)
  where status = 'open';
create index if not exists idx_state_elections_state_created on public.state_elections(state_id, created_at desc);

create table if not exists public.election_candidates (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references public.state_elections(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  statement text not null default '',
  created_at timestamptz not null default now(),
  unique(election_id, player_id)
);
create index if not exists idx_election_candidates_election on public.election_candidates(election_id);

create table if not exists public.election_votes (
  election_id uuid not null references public.state_elections(id) on delete cascade,
  voter_player_id uuid not null references public.players(id) on delete cascade,
  candidate_id uuid not null references public.election_candidates(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(election_id, voter_player_id)
);
create index if not exists idx_election_votes_candidate on public.election_votes(candidate_id);

create table if not exists public.state_badges (
  id uuid primary key default gen_random_uuid(),
  state_id uuid not null references public.states(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  badge_key text not null,
  title text not null,
  description text not null,
  icon text not null default '◆',
  earned_at timestamptz not null default now(),
  unique(state_id, badge_key, season_id)
);
create index if not exists idx_state_badges_state on public.state_badges(state_id, earned_at desc);

alter table public.state_elections enable row level security;
alter table public.election_candidates enable row level security;
alter table public.election_votes enable row level security;
alter table public.state_badges enable row level security;

drop policy if exists "public read state elections" on public.state_elections;
create policy "public read state elections" on public.state_elections for select to anon, authenticated using (true);
drop policy if exists "public read state badges" on public.state_badges;
create policy "public read state badges" on public.state_badges for select to anon, authenticated using (true);
-- Candidates/votes intentionally have no anon policies. Aggregated results come from Vercel API.

create or replace function public.gw_touch_election() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_election_id uuid;
begin
  if tg_op = 'DELETE' then
    v_election_id := old.election_id;
  else
    v_election_id := new.election_id;
  end if;
  update public.state_elections set updated_at = now() where id = v_election_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_election_candidate on public.election_candidates;
create trigger trg_touch_election_candidate after insert or update or delete on public.election_candidates
for each row execute function public.gw_touch_election();
drop trigger if exists trg_touch_election_vote on public.election_votes;
create trigger trg_touch_election_vote after insert or update or delete on public.election_votes
for each row execute function public.gw_touch_election();

create or replace function public.gw_cast_vote(
  p_election_id uuid,
  p_voter_player_id uuid,
  p_candidate_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  candidate public.election_candidates%rowtype;
begin
  select * into e from public.state_elections where id = p_election_id for update;
  if not found then raise exception 'Выборы не найдены.'; end if;
  if e.status <> 'open' or e.ends_at <= now() then raise exception 'Голосование уже закрыто.'; end if;
  if not exists(select 1 from public.state_members where state_id = e.state_id and player_id = p_voter_player_id) then
    raise exception 'Голосовать могут только граждане этого государства.';
  end if;
  select * into candidate from public.election_candidates where id = p_candidate_id and election_id = p_election_id;
  if not found then raise exception 'Кандидат не найден.'; end if;
  insert into public.election_votes(election_id, voter_player_id, candidate_id)
  values (p_election_id, p_voter_player_id, p_candidate_id)
  on conflict (election_id, voter_player_id) do update
    set candidate_id = excluded.candidate_id, created_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.gw_finalize_election(
  p_election_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  winner uuid;
  winner_votes bigint;
begin
  select * into e from public.state_elections where id = p_election_id for update;
  if not found then raise exception 'Выборы не найдены.'; end if;
  if e.status = 'resolved' then
    return jsonb_build_object('applied', false, 'winnerPlayerId', e.winner_player_id);
  end if;
  if e.status <> 'open' then raise exception 'Выборы нельзя завершить.'; end if;
  if e.ends_at > now() then raise exception 'Голосование ещё продолжается.'; end if;

  select c.player_id, count(v.voter_player_id)
  into winner, winner_votes
  from public.election_candidates c
  left join public.election_votes v on v.candidate_id = c.id
  where c.election_id = p_election_id
  group by c.id, c.player_id, c.created_at
  order by count(v.voter_player_id) desc, c.created_at asc
  limit 1;

  if winner is null then
    update public.state_elections set status = 'cancelled' where id = p_election_id;
    return jsonb_build_object('applied', true, 'cancelled', true);
  end if;

  update public.state_members set role = 'citizen' where state_id = e.state_id and role = 'president';
  update public.state_members set role = 'president' where state_id = e.state_id and player_id = winner;
  update public.states set owner_player_id = winner where id = e.state_id;
  update public.state_elections set status = 'resolved', winner_player_id = winner where id = p_election_id;

  return jsonb_build_object('applied', true, 'winnerPlayerId', winner, 'votes', coalesce(winner_votes,0));
end;
$$;

revoke all on function public.gw_cast_vote(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.gw_finalize_election(uuid) from public, anon, authenticated;
grant execute on function public.gw_cast_vote(uuid,uuid,uuid) to service_role;
grant execute on function public.gw_finalize_election(uuid) to service_role;

-- Realtime: elections and identity should update every open Mini App.
do $$ begin
  alter publication supabase_realtime add table public.state_elections;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.state_badges;
exception when duplicate_object then null; end $$;

create or replace function public.gw_get_election(
  p_state_id uuid,
  p_player_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.state_elections%rowtype;
  v_candidates jsonb;
  v_my_vote uuid;
begin
  select * into e
  from public.state_elections
  where state_id = p_state_id
  order by created_at desc
  limit 1;
  if not found then return null; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', ranked.id,
      'playerId', ranked.player_id,
      'displayName', ranked.display_name,
      'statement', ranked.statement,
      'votes', ranked.votes,
      'isMe', ranked.player_id = p_player_id
    ) order by ranked.votes desc, ranked.created_at asc
  ), '[]'::jsonb)
  into v_candidates
  from (
    select c.id, c.player_id, p.display_name, c.statement, c.created_at, count(v.voter_player_id)::integer as votes
    from public.election_candidates c
    join public.players p on p.id = c.player_id
    left join public.election_votes v on v.candidate_id = c.id
    where c.election_id = e.id
    group by c.id, c.player_id, p.display_name, c.statement, c.created_at
  ) ranked;

  select candidate_id into v_my_vote
  from public.election_votes
  where election_id = e.id and voter_player_id = p_player_id;

  return jsonb_build_object(
    'id', e.id,
    'status', e.status,
    'startsAt', e.starts_at,
    'endsAt', e.ends_at,
    'winnerPlayerId', e.winner_player_id,
    'myVoteCandidateId', v_my_vote,
    'candidates', v_candidates
  );
end;
$$;

revoke all on function public.gw_get_election(uuid,uuid) from public, anon, authenticated;
grant execute on function public.gw_get_election(uuid,uuid) to service_role;
