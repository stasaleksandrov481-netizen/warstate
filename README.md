# WARSTATE v5.4.2 — Continental Strategy Release

WARSTATE is a Telegram bot + Mini App where every connected Telegram group becomes a state on one shared continent.

The v5 redesign replaces the former island/ocean presentation with a serious state-strategy interface built around castles, territories, government, army, treasury, diplomacy, elections and emergency events.

## Product principles

- A new player should understand the main loop in about 30 seconds.
- Short, neutral bot copy. No roleplay language, slang or decorative text walls.
- Large actions and clear feedback instead of hidden controls.
- Dark brown, stone gray, dark green, gold and bronze visual language.
- Serif-led typography with safe fallbacks: Cinzel / IM Fell English / Lora / Georgia.
- Smooth fades and material feedback. No bouncing interface motion.
- Historical database identifiers such as `island_*` remain internal for backward compatibility. They are not shown to players.

## Mini App structure

### First launch

The first launch opens a four-step onboarding:

1. Castle: treasury, army and development.
2. Map: states, neighbors, allies and opponents.
3. Decisions: alliances, wars and elections.
4. Emergencies: react within 10 minutes.

Experienced players can skip onboarding. Completion is stored locally under `warstate:onboarding:v5`.

### Main menu

The default screen is a command center with six large sections:

- Castle
- Army
- Alliances
- Elections
- Map
- Rating

Every section has contextual `? What is this?` help. The bottom navigation stays compact and exposes the most common destinations.

### Continental map and LOD

`components/game/island-map.tsx` keeps its historical export name for compatibility, but renders a continent rather than islands.

Three LOD levels are selected from zoom:

- LOD 1: castle/crest markers only.
- LOD 2: castle + state name + President.
- LOD 3: population, army, treasury and alliance count.

Allied states are connected visually. State cards expose ELO, territory integrity, President, active players and actions relevant to the current player.

## Telegram bot

### `!помощь`

The command uses one editable Telegram message with five compact sections:

- 🏰 Замок
- 💼 Роли
- 💰 Экономика
- ⚔️ Военные действия
- 👤 Профиль

The inline keyboard stays under the same message while `editMessageText` switches the content. The sections document the current role economy, `!добыча`, `!сдать`, `!магазин`, Spy/Diplomat commands, wars, interstate `!соо`, profile progression and project-admin diagnostics.

### Emergency schedule

Emergencies use each state's IANA timezone from `states.time_zone`.

- Active window: 08:00–23:00 state local time.
- Cadence: every 5 hours during the active window.
- Reaction window: 10 minutes.
- Ignored emergency: real losses are applied without exposing exact loss values in the message.
- Night period: no new emergencies until 08:00.

The project fallback timezone is `WARSTATE_TIMEZONE` and defaults to `Europe/Moscow`.

State leadership can inspect or change the timezone:

```text
!часовойпояс
!часовойпояс Europe/Paris
```

Changing it clears `next_threat_at`, so the next emergency is recalculated using the new local time.

## Database upgrade

Apply migrations in order through:

```text
supabase/migrations/034_continent_redesign.sql
```

Migration `034_continent_redesign.sql`:

- adds `states.time_zone`;
- resets scheduled threat timestamps so the new five-hour cadence is armed cleanly;
- replaces the last marine activity label while preserving its stable option key.

Do not rename or delete historical `island_*`, `is_freeport` or `is_beginner_island` columns only for visual cleanup. They are part of existing RPC/API contracts. The v5 copy boundary translates historical database messages before they reach the Mini App or bot.

## Core commands

```text
!помощь
!играть
!государство
!статус
!ресурсы
!казна
!постройки
!улучшить <постройка>
!налоги

!президент
!замы
!выборы
!голосовать @username
!назначитьпрезидента @username
!снятьпрезидента
!назначитьзама @username
!снятьзама @username

!роли
!роль @username <дипломат|шпион|шахтер|рабочий|снять>
!министртруда @username
!снятьминистра @username

!карта
!рейтинг
!альянсы
!союз @state
!разорватьсоюз @state

!война @state <raid|siege|territory>
!бой
!оборона
!разведка @state
!сдаться

!чп
!часовойпояс Europe/Paris
```

## Event-driven runtime

Normal gameplay does not require a Vercel Cron schedule. Telegram activity and Mini App actions reconcile state maintenance. PostgreSQL remains authoritative for idempotency, battles, balances and maintenance claims.

Optional backup endpoints can still be invoked externally for quiet chats, but `vercel.json` does not require a scheduled cron.

## Telegram setup

The bot must receive ordinary group messages so `!commands` and live state reconciliation work reliably.

In BotFather:

```text
/setprivacy
```

Disable Privacy Mode for the WARSTATE bot, then remove/re-add the bot to existing groups if Telegram requires it.

The bot should have permissions needed for member checks, invite links and the actions used by your deployment.

## Local development

Requirements:

- Node.js 22.x
- npm
- Supabase project
- Telegram bot token

Install and verify:

```bash
npm ci
npm run audit:project
npm run typecheck
npm run build
npm run dev
```

Copy `.env.example` to your local environment file and fill all required values. Never commit real secrets.

## Production checks

Before deploy:

```bash
npm ci
npm run audit:project
npm run typecheck
npm run build
```

Then apply all pending Supabase migrations, configure the Telegram webhook and deploy the Next.js application.

## v5 implementation map

Key redesign files:

```text
app/warstate-redesign.css
components/game-app.tsx
components/game/island-map.tsx
components/game/island-home.tsx
lib/chat-commands.ts
lib/dynamic-events.ts
lib/game-guide.ts
lib/copy.ts
supabase/migrations/034_continent_redesign.sql
```

`npm run audit:project` is updated for the v5 baseline and checks the continental map markers, migration presence, command routing, RPC coverage, environment documentation, webhook idempotency and security headers.

## WARSTATE v5.1: Admin rewards, medals and group access

Before deploying v5.1, apply `supabase/migrations/035_admin_rewards_medals_access.sql`.

`TELEGRAM_BOT_USERNAME` is now a hard runtime requirement. If the bot has no Telegram username configured, both the webhook and authenticated Mini App API reject use until the username is set.

Project admins configured through `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS` can open the Admin Mini App and:

- grant resources, treasury credits, prestige, reputation, influence, temporary army boosts, emergency shields, state-wide XP boosts, starter packs, titles and medals;
- issue medals to a player or a state;
- send a free-form Administration message to one state;
- review the grant/message audit history;
- open public Telegram groups directly;
- request access to private groups. The bot sends a force-reply request to the group and forwards a valid owner/admin invite-link reply to the requesting project admin in a private message.

Admin grants are confirmed in the UI before execution and are logged in `admin_reward_log`. Player and state medals are stored separately in `player_medals` and `state_medals`.

## WARSTATE v5.3: map interaction, Telegram safe-area and interstate messages

Before deploying v5.3, apply `supabase/migrations/039_interstate_messages.sql` after the previous migrations.

### Interstate communication

A citizen can write from one state chat to another registered state:

```text
!соо @state_username Текст сообщения
```

The target chat receives a system interstate message. A participant of that chat can answer it with Telegram Reply; the bot routes the answer back to the originating state. Replies remain routable in both directions because each delivered bot message is stored by exact Telegram `chat_id + message_id`.

### Map and camera

The map is Canvas-rendered. State coordinates are transformed by the camera, while castles are rendered in screen space at a stable visual size. Far zoom uses screen-space decluttering so readable castles do not overlap excessively. Panning has a click threshold and inertia; pinch gestures never select a state on release.

Telegram `safeAreaInset` / `contentSafeAreaInset` values and the official Mini App CSS safe-area variables are included in layout calculations so the native Telegram header does not cover the Mini App UI.

## WARSTATE v5.4: closed economy, buffered Canvas and interactive help

Before deploying v5.4, apply `supabase/migrations/040_personal_economy_v54.sql`.

The update separates personal economy from the state treasury, adds role gathering, selling, tools, Houses, consumables, noble titles and ELO investments. Raw state resources are now citizen-driven. A humanitarian reserve of 50 units prevents economy softlocks, while infrastructure sleeps instead of being destroyed when upkeep cannot be paid.

The Canvas map now uses a 25% render buffer, buffered terrain, a shared sprite atlas, far-LOD anti-overlap and context restoration handling. Telegram `!помощь` is a five-section inline menu that edits one message in place.

## WARSTATE v5.4.2 release hardening

For a fresh or upgraded deployment, apply migrations through `supabase/migrations/043_release_final_hardening.sql`. In particular, v5.4.2 requires `041`, `042` and `043` after the v5.4 economy migration.

The release-candidate audit now verifies API authorization boundaries, every application RPC against migrations, Telegram webhook lease/completion idempotency, SECURITY DEFINER revokes, command routing, Mini App safe areas and the final UI normalization layer. Canvas avatar decoding is bounded so long map sessions cannot grow an unlimited image cache.
