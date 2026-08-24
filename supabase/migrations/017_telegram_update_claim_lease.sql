create or replace function public.gw_claim_telegram_update(
  p_update_id bigint,
  p_lease_seconds integer default 45
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

revoke all on function public.gw_claim_telegram_update(bigint, integer) from public,anon,authenticated;
grant execute on function public.gw_claim_telegram_update(bigint, integer) to service_role;

drop function if exists public.gw_claim_telegram_update(bigint);
