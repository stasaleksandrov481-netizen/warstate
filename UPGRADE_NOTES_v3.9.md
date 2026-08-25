# WARSTATE 3.9 stable

## Required database step
Apply `supabase/migrations/027_webhook_idempotency_and_presence.sql` after migrations 024-026.

Migration 027:
- fixes repeated `uq_state_members_one_home` webhook failures;
- makes `gw_set_player_home_state` idempotent;
- repairs Telegram update receipt RPC signatures;
- adds observed Telegram group-member presence without forcing citizenship changes;
- makes repeated switching to the current island a no-op;
- creates no cron jobs.

## Creator access
Keep the creator numeric Telegram ID in `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS`.
In any group use:
- `!полныеправа` to enable all WARSTATE command rights in that chat;
- `!снятьдоступ` to disable them.

The creator mode does not move the creator's real citizenship to the chat being serviced.

## Telegram group behavior
- New members and active senders are registered as WARSTATE player profiles without needing Mini App.
- A player with no conflicting home state is enrolled automatically.
- A player already belonging to another normal state is observed but not silently stolen from that state; `!вступить` remains the explicit transition path.
- `!назначитьзама` / `!снятьзама` can be used as a reply to a member message or with `@username`.
- President and Founder can manage deputies.

## Deployment packaging
This archive is intentionally flat: `package.json`, `app/`, `lib/`, etc. are at ZIP root.
Old nested project copies and `tsconfig.tsbuildinfo` are not included, preventing TypeScript from compiling stale duplicate sources.

`vercel.json` contains no Vercel Cron schedule. Runtime maintenance remains event-driven.
