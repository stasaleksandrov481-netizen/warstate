-- WARSTATE v2.0.0 / event-driven runtime
-- Removes the hard dependency on Vercel Cron. Live requests/messages claim a
-- short maintenance lease in PostgreSQL and reconcile only the state they touch.

alter table public.states
  add column if not exists maintenance_checked_at timestamptz;

create index if not exists idx_states_maintenance_checked_at
  on public.states(maintenance_checked_at);

create index if not exists idx_state_elections_due
  on public.state_elections(state_id, ends_at)
  where status = 'open';

create index if not exists idx_battles_attacker_runtime
  on public.battles(attacker_state_id, status, ends_at)
  where status in ('scheduled','active');

create index if not exists idx_battles_defender_runtime
  on public.battles(defender_state_id, status, ends_at)
  where status in ('scheduled','active');

-- Atomic maintenance lease. This is intentionally state-scoped: opening one
-- busy state must not scan every battle/election in the whole world.
create or replace function public.gw_claim_state_maintenance(
  p_state_id uuid,
  p_interval_seconds integer default 20
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  safe_interval integer := greatest(1, least(300, coalesce(p_interval_seconds, 20)));
begin
  update public.states
  set maintenance_checked_at = now()
  where id = p_state_id
    and (
      maintenance_checked_at is null
      or maintenance_checked_at <= now() - make_interval(secs => safe_interval)
    )
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

revoke all on function public.gw_claim_state_maintenance(uuid,integer) from public,anon,authenticated;
grant execute on function public.gw_claim_state_maintenance(uuid,integer) to service_role;

-- Useful diagnostics without needing another scheduled job.
create or replace function public.gw_runtime_health(p_state_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'stateId', s.id,
    'maintenanceCheckedAt', s.maintenance_checked_at,
    'dueElections', (
      select count(*) from public.state_elections e
      where e.state_id = s.id and e.status = 'open' and e.ends_at <= now()
    ),
    'liveBattles', (
      select count(*) from public.battles b
      where b.status in ('scheduled','active')
        and (b.attacker_state_id = s.id or b.defender_state_id = s.id)
    ),
    'dueBattles', (
      select count(*) from public.battles b
      where b.status in ('scheduled','active') and b.ends_at <= now()
        and (b.attacker_state_id = s.id or b.defender_state_id = s.id)
    )
  )
  from public.states s
  where s.id = p_state_id;
$$;

revoke all on function public.gw_runtime_health(uuid) from public,anon,authenticated;
grant execute on function public.gw_runtime_health(uuid) to service_role;

-- Telegram can redeliver webhook updates. Keep command/callback delivery
-- idempotent in PostgreSQL so retries cannot double-start wars, elections,
-- upgrades or diplomacy actions when several serverless instances race.
create table if not exists public.telegram_update_receipts (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

create index if not exists idx_telegram_update_receipts_received_at
  on public.telegram_update_receipts(received_at);

create or replace function public.gw_claim_telegram_update(p_update_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id bigint;
begin
  if p_update_id is null or p_update_id < 0 then
    return false;
  end if;

  insert into public.telegram_update_receipts(update_id)
  values (p_update_id)
  on conflict (update_id) do nothing
  returning update_id into inserted_id;

  -- Opportunistic bounded cleanup keeps the receipt table small without any
  -- scheduled task. Telegram update ids are monotonically increasing enough
  -- for this inexpensive sampling strategy.
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

  return inserted_id is not null;
end;
$$;

revoke all on function public.gw_claim_telegram_update(bigint) from public,anon,authenticated;
grant execute on function public.gw_claim_telegram_update(bigint) to service_role;
