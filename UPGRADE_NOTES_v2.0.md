# WARSTATE v2.0.0 upgrade notes

## Why this release exists

Vercel Cron is no longer a gameplay dependency. WARSTATE now reconciles timed state through live user activity and a PostgreSQL maintenance lease.

## Required database change

If v1.9 (`014_government_chat_control.sql`) is already applied, execute only:

```text
supabase/migrations/015_event_driven_runtime.sql
```

Fresh databases still apply `001` through `015` in order.

## Vercel

`vercel.json` intentionally contains no `crons` section. Do not add the old per-minute battle/election schedules back unless you intentionally want optional backup jobs and have quota available.

The existing `/api/cron/battles` and `/api/cron/elections` routes are retained for manual backup use only.

## Redis

Upstash is recommended but no longer mandatory for availability. Without it, short rate limits and locks fall back to process memory while PostgreSQL remains authoritative. For multiple busy production instances, Upstash is still the stronger coordination layer.

## Telegram webhook

Re-run:

```bash
npm run telegram:configure
```

Migration `015` adds idempotent Telegram update receipts. Ordinary commands/callbacks cannot be replayed twice by Telegram redelivery.

## Runtime check

An authenticated state member can call:

```text
GET /api/game/runtime?stateId=<uuid>
```

The response shows due battles/elections, maintenance state and whether Redis is running as `upstash` or `local-fallback`.

## Verification

```bash
npm install
npm run audit:project
npm run typecheck
npm run build
```

`audit:project` also verifies that Vercel Cron schedules have not returned accidentally.
