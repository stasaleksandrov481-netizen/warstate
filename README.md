# WARSTATE v2.0.0 — Event-Driven Core

Telegram Mini App strategy where every real Telegram group becomes a persistent island-state in one shared ocean world.

## What changed in v2.0

### No mandatory Vercel Cron

WARSTATE no longer depends on Vercel scheduled jobs for normal gameplay.

Expired elections, active battles, finished construction and strategic refreshes are reconciled by live activity:

- opening the Mini App;
- refreshing a state;
- participating in a battle;
- starting a new war;
- government actions;
- ordinary Telegram group activity.

`supabase/migrations/015_event_driven_runtime.sql` adds an atomic state-scoped maintenance lease. Only one serverless request per state/interval performs maintenance, so a busy group does not create duplicate finalizers.

The old `/api/cron/battles` and `/api/cron/elections` routes remain as optional manual/backup endpoints, but `vercel.json` contains **no cron schedules** and the game does not require them.

### Redis is now optional for availability

Upstash Redis is still preferred for global rate limits and short action locks. If it is missing or temporarily unavailable, WARSTATE falls back to an in-process limiter/lock while PostgreSQL RPCs remain authoritative for balances, battles and idempotency.

This means a Redis outage no longer disables attacks, activities or alliance support.

### Telegram delivery is idempotent

Telegram may redeliver the same webhook update. Migration `015` stores compact update receipts in PostgreSQL, and ordinary commands/callbacks are claimed exactly once before gameplay logic runs. Receipts older than seven days are cleaned opportunistically without a scheduled job. Successful payments keep their separate Telegram charge-id idempotency path so failed entitlement writes can still retry safely.

Group `!` commands are handled on the **critical path before optional maintenance**. Ordinary group messages then settle due votes and run lightweight state reconciliation on a best-effort path, so a maintenance hiccup cannot silence chat commands.

### Runtime diagnostics

Authenticated state members can inspect the current event-driven runtime through:

```text
GET /api/game/runtime?stateId=<uuid>
```

It reports runtime mode, Redis mode, maintenance results and due/live state work.

### Safer production defaults

- Next.js no longer exposes the `X-Powered-By` header.
- Baseline `nosniff`, no-referrer and restrictive browser permission headers are sent globally.
- Telegram webhook commands/callbacks are PostgreSQL-idempotent.
- Redis network calls have a short timeout and automatically degrade to the local availability fallback.

### UI/UX polish

- Added a compact live event ribbon for active battles, construction, elections and ready mission rewards.
- Bottom navigation now shows contextual attention dots for battle, diplomacy, construction and rewards.
- Improved shared focus states, scrollbars, loading scene and page-surface consistency.
- Background full-state polling was relaxed because Supabase Realtime remains the primary update path.
- Existing Gameworld animations, inertial world map, detailed procedural islands and reduced-motion support remain intact.

### Chat cleanup

- `!государства` no longer exposes raw Telegram Chat IDs; it shows public state names/handles.
- Election launch messages no longer expose internal election UUIDs.
- State usernames remain the public address for war, alliance, reconnaissance and search.

## Government

Roles:

- Founder
- President
- up to 3 Deputies
- Citizen
- Curator on Beginner Island

The Founder can appoint/remove the President, manage Deputies, start 30-minute elections, rename the state and manage the unique state handle.

A Telegram chat is registered automatically when the bot is added. The actual Telegram chat creator is verified and stored as Founder.

New-state defaults:

```text
Level       1
Budget      1000
Influence   100
Technology  50
Reputation  100
Army        100
Defense     120
```

## State handles

States have a unique handle such as:

```text
@north_empire
@wolves
@sunset
```

Rules:

- `a-z`, `0-9`, `_` only;
- 4–32 characters;
- case-insensitive uniqueness;
- Founder only;
- after initial setup, changes are limited to once per 30 days.

Handles can be used in war, alliance, reconnaissance and search commands.

## Core chat commands

```text
!помощь
!играть                # подробная инструкция как играть
!как_играть            # алиас
!гайд                   # алиас
!государство
!статус
!ресурсы
!рейтинг
!карта
!альянсы
!профиль
!роли
!роль @username <дипломат|шпион|шахтер|рабочий|снять>
!голосование
!шпион @название_государства

!президент
!замы
!выборы
!голосовать @username
!назначитьпрезидента @username
!снятьпрезидента
!назначитьзама @username
!снятьзама @username
!создатьюз north_empire
!юз new_handle
!название Новое Государство
!найти north

!казна
!постройки
!улучшить <постройка>
!налоги

!война @название_государства <raid|siege|territory>
!бой
!оборона
!разведка @название_государства
!сдаться

!союз @название_государства
!союз принять [@название_государства]
!союз отклонить [@название_государства]
!разорватьсоюз @название_государства

!активность
!миссия
!награда
```

Every ordinary citizen message can award `+2 XP` and `+1 state contribution`, at most once per minute. The cooldown is enforced in PostgreSQL.

## How to play guide

New players can open the detailed Russian-language guide directly in a state chat with `!играть` (aliases: `!как_играть`, `!какиграть`, `!гайд`). The same guide is available as a compact expandable section on the Mini App profile screen. It covers joining a state, Telegram membership verification, roles, resource farming, wars and civic votes, alliances, spy quests, daily actions and the main commands.


## Battle balance

Migration `013_full_state_wars_spec.sql` stores battle modifiers in the battle row for transparent/reproducible results.

```text
state_size = active_players ^ 0.4 × game_level ^ 0.6
attack_penalty = min(30%, 8% × max(0, log2(attacker_size / defender_size)))
underdog_bonus = min(25%, 7% × max(0, log2(attacker_size / defender_size)))
```

Additional systems:

- Defensive Buffer;
- aggressor fatigue up to 15%;
- fixed random modifiers 0.85–1.15;
- alliance support cap 35%;
- true draw below 5% score difference;
- capped resource loot;
- recovery shield after defeat.

War durations:

```text
raid       15 min
territory  20 min
siege      30 min
```

## Stack

- Next.js 16
- React 19
- TypeScript
- Supabase Postgres + Realtime
- Telegram Bot API + Mini App
- Vercel
- optional Upstash Redis REST

## Environment

Copy `.env.example` and fill the values.

Required:

```text
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_MINI_APP_SHORT_NAME=
TELEGRAM_WEBHOOK_SECRET=
```

Supported legacy Supabase aliases:

```text
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Optional:

```text
BEGINNER_ISLAND_CHAT_ID=
WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS=
WARSTATE_SUPERADMIN_TELEGRAM_ID=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
CRON_SECRET=
```

`CRON_SECRET` is only needed if you intentionally call the manual backup cron endpoints. Vercel Cron itself is not required in v2.0.

## Supabase migrations

Fresh database: apply `001` through `025` in numeric order.

Existing v1.9 database: apply sequentially:

```text
supabase/migrations/015_event_driven_runtime.sql
supabase/migrations/016_member_activity_votes_spy.sql
supabase/migrations/017_telegram_update_claim_lease.sql
supabase/migrations/018_state_switch_delete_ui.sql
supabase/migrations/019_fix_state_switch_cooldown.sql
supabase/migrations/020_integrity_repair.sql
supabase/migrations/021_fix_stale_election_conflict.sql
supabase/migrations/022_fix_state_color_contrast.sql
supabase/migrations/023_founder_president_admin.sql
supabase/migrations/024_repair_government_commands.sql
supabase/migrations/025_compact_world_and_map_repair.sql
```

Migration `016` adds member specializations, civic war/alliance votes, the 10-message resource farm, and spy quests. Migration `017` makes Telegram update claims retry-safe. Migration `018` adds explicit state switching and owner-only state deletion. Migration `023` lets a Founder also hold the President office, restores the Founder role when that presidency ends, and keeps Founder self-promotion inside elections unless the account is explicitly configured as the project testing admin. Migration `024` restores the government command RPCs with stable PostgREST argument names. Migration `025` compacts the island world, repairs island-slot placement, and keeps future islands close to the active cluster. If your database is older, apply every missing migration sequentially. Do not skip intermediate migrations.

## Project creator testing admin

For development and bot testing, one or more trusted Telegram accounts can receive a creator-only control in the Profile government panel. This is intentionally keyed by immutable numeric Telegram user ID rather than username.

1. Send `!мойид` in one of your WARSTATE state chats.
2. Put that numeric ID into `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS` (comma-separated if you use more than one test account).
3. Redeploy/restart the server after changing environment variables.
4. Send `!админ` to confirm the flag, then use `!назначитьпрезидента` with no username, or the **Админ-панель проекта** button in Profile.

The creator override only works inside a state whose `founder_player_id` is that same player. It does not grant control over somebody else's state. Ordinary chat Founders can also become President, but self-promotion opens/joins a 30-minute citizen election and requires at least one vote from another citizen and a majority of votes cast; the Founder cannot approve their own nomination.

## Telegram setup

After deployment:

```bash
npm run telegram:configure
```

The webhook subscribes to:

- `message`
- `callback_query`
- `my_chat_member`
- `pre_checkout_query`

### Required Telegram group settings for `!` commands

To receive ordinary group messages such as `!война`, `!карта`, and `!помощь`, WARSTATE should be a **group administrator**. Telegram also allows a non-admin bot to receive them when Privacy Mode is disabled. For predictable deployment, keep the bot as an administrator and in **BotFather** run `/setprivacy` -> select the bot -> **Disable**. After changing Privacy Mode, re-add the bot to existing groups if Telegram has not applied the new setting there yet.

Grant the bot permission to invite users. WARSTATE uses `getChatMember` before granting citizenship and creates an invite link when the player is not yet in the state's Telegram chat. `getChatMember` is guaranteed for other users when the bot is an administrator.

## Verification

```bash
npm install
npm run audit:project
npm run typecheck
npm run build
```

`npm run audit:project` checks:

- local imports;
- environment documentation;
- legacy/secret paths;
- application RPCs against SQL migrations;
- required Telegram commands;
- v2.0 event-driven files;
- absence of scheduled crons in `vercel.json`;
- Telegram webhook idempotency;
- baseline security headers.

## Important

PostgreSQL remains the source of truth. Client state, Realtime events, Redis locks and serverless process memory are never trusted as authoritative balances or battle results.

## v3.8 chat-first administration

- `!вступить` registers the sender and joins the state of the current Telegram group without opening Mini App.
- New Telegram members are enrolled when Telegram sends `new_chat_members`; existing silent members are enrolled on first activity/command because Telegram Bot API does not expose a complete historical member list.
- Founder **or President** can appoint/remove deputies. `!назначитьзама` and `!снятьзама` also work as a reply to a member's message, so a Telegram username is not required.
- Project creator global command mode is explicitly activated per chat with `!суперадмин` and disabled with `!суперадмин выкл`. Only IDs configured in `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS` can activate it.
- `!оботе` explains the project and chat-first gameplay.

## WARSTATE 3.9 stable notes

- Runtime marker: `WARSTATE_RUNTIME=3.9-stable`.
- In Telegram, `!версия` must report `WARSTATE 3.9-stable` after the new code is live.
- Project creator chat override: `!полныеправа`, disable with `!снятьдоступ`.
- Apply migration `027_webhook_idempotency_and_presence.sql` to remove repeated one-home duplicate-key webhook failures and restore update receipt idempotency.
- No Vercel Cron schedule is configured in `vercel.json`.
