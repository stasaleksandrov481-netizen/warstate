-- WARSTATE v5.4.2 final release hardening.
-- SECURITY DEFINER trigger helpers are internal database implementation details
-- and must never be callable directly from PostgREST clients.

revoke all on function public.gw_prepare_battle_strategy() from public, anon, authenticated;
revoke all on function public.gw_apply_admin_xp_boost() from public, anon, authenticated;
revoke all on function public.gw_enforce_state_resource_floor() from public, anon, authenticated;
