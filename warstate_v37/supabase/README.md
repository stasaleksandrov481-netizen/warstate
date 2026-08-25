# WARSTATE Supabase setup

Apply migrations strictly in numeric order:

```text
001_init.sql
002_realtime_battles.sql
003_commanders_squads.sql
004_diplomacy_world_feed.sql
005_daily_ops_guardrails.sql
006_atomic_battle_actions.sql
007_seasons_politics_identity.sql
008_island_world_elo.sql
009_island_integrity_campaigns.sql
010_island_world_polish.sql
011_freeport_live_recruitment.sql
012_live_integrity_audit.sql
013_full_state_wars_spec.sql
014_government_chat_control.sql
015_event_driven_runtime.sql
016_member_activity_votes_spy.sql
017_telegram_update_claim_lease.sql
```

For an existing v1.9 installation that already has `014`, apply the rest in order:

```text
015_event_driven_runtime.sql
016_member_activity_votes_spy.sql
017_telegram_update_claim_lease.sql
```

`015` removes the normal gameplay dependency on Vercel Cron. It adds a state-scoped PostgreSQL maintenance lease plus due-event indexes. Mini App activity and Telegram group activity safely reconcile battles, elections, construction and strategy state.

The same migration also adds PostgreSQL-backed Telegram update receipts. Ordinary webhook commands/callbacks are claimed exactly once, so Telegram redelivery cannot duplicate a war, election, upgrade or diplomacy action. Old receipts are pruned opportunistically without a scheduled task.

`017` fixes a real bug in that claim: it used to be a *permanent* claim taken before the command actually ran, so if a first attempt was ever interrupted mid-processing (a serverless timeout, a slow cold start, a redeploy), Telegram's retry of that same update would be treated as an already-claimed duplicate and silently dropped — the bot would look like it answered once and then went quiet for every command after that. `017` turns the permanent claim into a short (45s) lease: a genuine duplicate arriving while the first attempt is still in flight is still ignored, but if the lease expires without success, the retry is allowed to run the command for real. Apply `017` even on installations that already ran `015`/`016` — it replaces the function from `015`.

## Keys

Server routes need one server-side Supabase credential:

```text
SUPABASE_SECRET_KEY
```

or the legacy alias:

```text
SUPABASE_SERVICE_ROLE_KEY
```

The browser uses the publishable key (or legacy anon key). Never expose a service-role/secret key with a `NEXT_PUBLIC_*` prefix.

## Source of truth

All balances, memberships, state roles, activity cooldowns, battle finalization and government mutations are authoritative in PostgreSQL. Realtime and Redis are acceleration/coordination layers only.
