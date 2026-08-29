-- WARSTATE v5.4.2 release polish.
-- Keep admin payment aggregates accurate at any database size without pulling
-- thousands of payment rows through PostgREST.

create or replace function public.gw_admin_payment_totals()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'starsTotal', coalesce(sum(stars), 0)::bigint,
    'starsLast7d', coalesce(sum(stars) filter (where created_at >= now() - interval '7 days'), 0)::bigint
  )
  from public.payments;
$$;

revoke all on function public.gw_admin_payment_totals() from public, anon, authenticated;
grant execute on function public.gw_admin_payment_totals() to service_role;

-- Crash-safe Telegram webhook receipts. A leased update is not a completed
-- update: retries must distinguish "still processing" from "already done".
alter table public.telegram_update_receipts
  add column if not exists completed_at timestamptz;

-- Receipts created by pre-v5.4.2 code represented already acknowledged
-- updates, so mark historical rows complete during the upgrade.
update public.telegram_update_receipts
set completed_at = received_at
where completed_at is null;

create or replace function public.gw_claim_telegram_update_v2(
  p_update_id bigint,
  p_lease_seconds integer default 75
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id bigint;
  current_received timestamptz;
  current_completed timestamptz;
  safe_lease integer := greatest(5, least(120, coalesce(p_lease_seconds, 75)));
begin
  if p_update_id is null or p_update_id < 0 then
    return 'invalid';
  end if;

  insert into public.telegram_update_receipts(update_id, received_at, completed_at)
  values (p_update_id, now(), null)
  on conflict (update_id) do nothing
  returning update_id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;

  select received_at, completed_at
    into current_received, current_completed
  from public.telegram_update_receipts
  where update_id = p_update_id;

  if current_completed is not null then
    return 'completed';
  end if;

  update public.telegram_update_receipts
  set received_at = now()
  where update_id = p_update_id
    and completed_at is null
    and received_at < now() - make_interval(secs => safe_lease)
  returning update_id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;

  return 'processing';
end;
$$;

create or replace function public.gw_complete_telegram_update(p_update_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  completed_id bigint;
begin
  update public.telegram_update_receipts
  set completed_at = now(), received_at = now()
  where update_id = p_update_id
    and completed_at is null
  returning update_id into completed_id;
  return completed_id is not null;
end;
$$;

revoke all on function public.gw_claim_telegram_update_v2(bigint, integer) from public, anon, authenticated;
revoke all on function public.gw_complete_telegram_update(bigint) from public, anon, authenticated;
grant execute on function public.gw_claim_telegram_update_v2(bigint, integer) to service_role;
grant execute on function public.gw_complete_telegram_update(bigint) to service_role;
