# Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor** and run migrations strictly in order:

```text
migrations/001_init.sql
migrations/002_realtime_battles.sql
migrations/003_commanders_squads.sql
migrations/004_diplomacy_world_feed.sql
migrations/005_daily_ops_guardrails.sql
migrations/006_atomic_battle_actions.sql
migrations/007_seasons_politics_identity.sql
migrations/008_island_world_elo.sql
migrations/009_island_integrity_campaigns.sql
migrations/010_island_world_polish.sql
```

If your existing project already has `001`–`009`, run only `010_island_world_polish.sql` for v1.2.

3. In Project Settings/API copy:
   - Project URL -> `NEXT_PUBLIC_SUPABASE_URL`
   - Publishable key (or legacy anon key) -> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - Server secret/service-role key -> `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
4. Never expose the secret/service-role key as a `NEXT_PUBLIC_*` variable.

Writes are intentionally performed only from Vercel server routes after Telegram `initData` validation. Sensitive state actions additionally re-check current Telegram group membership. RLS exposes only the public game-state reads required by the map/realtime UI.

## Migration notes

- `002_realtime_battles.sql` — realtime battle sessions, participants and combat events.
- `003_commanders_squads.sql` — squads and commander orders.
- `004_diplomacy_world_feed.sql` — diplomacy, global world feed and Realtime publication.
- `005_daily_ops_guardrails.sql` — daily missions, rookie shield, attack cooldown and atomic economy/battle RPCs.
- `006_atomic_battle_actions.sql` — atomic realtime combat actions and membership verification timestamps.
- `007_seasons_politics_identity.sql` — state identity, elections, voting, badges and Realtime publication.
- `008_island_world_elo.sql` — infinite island placement, Telegram group metadata, viewport query, island battles and ELO.
- `009_island_integrity_campaigns.sql` — integrity, multi-battle destruction, ruins, repair and streaks.
- `010_island_world_polish.sql` — map-query indexes/limits, cheaper island viewport reads and idempotent battle rewards.
