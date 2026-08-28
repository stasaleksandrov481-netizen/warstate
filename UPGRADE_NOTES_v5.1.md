# WARSTATE v5.1 upgrade notes

## Required before deployment

1. Apply `supabase/migrations/035_admin_rewards_medals_access.sql` after all previous migrations.
2. Set `TELEGRAM_BOT_USERNAME` to the bot username without `@` (or with `@`; runtime normalizes it).
3. Keep project admin Telegram IDs in `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS` / `WARSTATE_SUPERADMIN_TELEGRAM_ID`.
4. Run:
   - `npm ci`
   - `npm run audit:project`
   - `npm run typecheck`
   - `npm run build`
5. Reconfigure the Telegram webhook only if the deployment URL/token changed.

## New database objects

- `player_medals`
- `state_medals`
- `admin_reward_log`
- `admin_chat_access_requests`
- state columns for prestige and temporary admin effects
- player `admin_title`
- `gw_admin_apply_reward(...)`
- `gw_apply_admin_xp_boost()` trigger

## Admin flow

The Admin Mini App now has a project-wide state selector, reward center, free-form Administration messages, history, direct opening for public groups and a private-group access request flow.

Private access does not generate a Telegram invite link. The bot posts a force-reply request in the group. A creator/administrator replies with an invite URL; the bot validates the sender, stores the link and forwards it to the project admin. If the private DM cannot be delivered, the fulfilled link remains recoverable from the Admin Mini App.

## Runtime guard

The Telegram webhook and authenticated Mini App API are blocked when `TELEGRAM_BOT_USERNAME` is missing. This is intentional.
