# WARSTATE v5.4.2 upgrade notes

## Database

If upgrading from v5.4.0, apply in order:

1. `supabase/migrations/041_release_candidate_audit.sql`
2. `supabase/migrations/042_release_polish.sql`
3. `supabase/migrations/043_release_final_hardening.sql`

If `041`/`042` are already applied, apply only the migrations that remain.

- `041` closes economy exploits and release-candidate invariants.
- `042` adds accurate admin Stars aggregates and crash-safe Telegram webhook receipt state.
- `043` removes direct client execution rights from internal SECURITY DEFINER trigger helpers.

## Environment

`TELEGRAM_BOT_USERNAME` is mandatory and must be a valid Telegram bot username ending in `bot`.

## Deploy validation

Run:

```bash
npm ci
npm run audit:project
npm run typecheck
npm run build
```

Do not enable the Telegram webhook against v5.4.2 until migrations through `043` have been applied. The webhook intentionally fails closed if its idempotency RPCs are missing.
