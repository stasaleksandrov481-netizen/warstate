# WARSTATE v2.0.0 — Final Audit

## Release focus

v2.0 replaces the normal gameplay dependency on Vercel Cron with an event-driven runtime and performs a broader reliability/UI pass on top of v1.9 Government.

## Major completed changes

- Removed scheduled jobs from `vercel.json`.
- Added migration `015_event_driven_runtime.sql`.
- Added PostgreSQL state-scoped maintenance leases.
- Battles, expired elections, finished construction and strategic refreshes reconcile through live Mini App / Telegram activity.
- Group commands reconcile state before command execution, so text UI and Mini App observe the same current world state.
- New wars/building actions reconcile stale runtime before validating conflicts.
- Fixed a race where strategy could refresh before a just-finished building upgrade was applied.
- Added an 8-second local burst throttle before the authoritative PostgreSQL maintenance lease for busy Telegram chats.
- Upstash Redis is no longer a hard availability dependency; short rate limits/locks degrade to an in-process fallback while PostgreSQL remains authoritative.
- Redis REST calls now have a short network timeout.
- Added PostgreSQL-backed Telegram webhook update idempotency for ordinary updates/callbacks.
- Added opportunistic cleanup of old Telegram update receipts without a scheduled task.
- Preserved separate payment idempotency by Telegram charge id, allowing failed payment writes to retry.
- Added authenticated `/api/game/runtime` diagnostics.
- Added baseline production security headers and disabled `X-Powered-By`.
- Corrected API status inference for rate limiting (`429`) and action conflicts (`409`).
- Added a live event ribbon for battles, construction, elections and ready rewards.
- Added contextual bottom-navigation attention indicators.
- Improved shared focus/loading/surface polish and reduced unnecessary background full-state polling.
- Removed raw Telegram chat IDs from public state listings and internal election UUIDs from launch messages.
- Expanded `audit:project` to validate RPCs, commands, webhook idempotency, security headers and absence of Vercel Cron schedules.

## Static verification

- `npm run audit:project`: PASS
- Source files scanned by project audit: 64
- API routes: 24
- Environment variables referenced/documented: 15
- Referenced RPCs found in SQL migrations: 31/31
- Required Telegram commands: 33/33
- TS/TSX syntax transpile check: 61/61
- `app/globals.css` structural check: PASS
- `app/game-theme.css` structural check: PASS
- Migration `015` dollar-quote structure: PASS
- TODO/FIXME/HACK/XXX scan: clean
- Obvious secret-assignment scan: clean
- Trailing-whitespace scan: clean
- `vercel.json`: no scheduled crons

## Build status

A real dependency install / `next build` could not be completed in this environment. `npm install` fails at the network layer with:

```text
EAI_AGAIN registry.npmjs.org
```

Therefore this audit does **not** claim a successful production Next.js build. The release was checked with dependency-independent static/transpile/import/RPC/CSS/security/project audits instead.

## Required deployment step

For an existing v1.9 database, apply:

```text
supabase/migrations/015_event_driven_runtime.sql
```

Then deploy normally. Vercel Cron is not required for v2.0 gameplay.
