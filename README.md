# GROUP WARS v1.1 — Game UI / Island World

Telegram-native multiplayer strategy. **Every Telegram group becomes an island-state** on an expandable ocean.

Stack:

- Next.js 16 / React 19
- Vercel
- Supabase Postgres + Realtime
- Telegram Bot API + Mini App
- Telegram Stars foundation

## v1.1: interface redesign

This version replaces the previous dashboard/SaaS-looking presentation with a mobile game-first UI.

### Main map

The primary screen is now the ocean itself:

- full-screen pannable ocean;
- pinch-to-zoom and wheel zoom;
- lightweight SVG island art rendered directly by React, not generated images;
- several deterministic coast shapes so islands do not look identical;
- beach, land relief, trees, houses, fortress, flag and pier;
- larger Telegram groups visually receive larger/more developed islands;
- destroyed islands render crater/smoke/ruins state;
- damaged islands display integrity;
- compact floating Telegram group label with avatar, members and ELO;
- alliance / war / ruin status markers;
- selected island opens a game-style attack sheet;
- minimap and center-on-my-island control;
- live world event ticker;
- active war banner leading directly to battle.

No external art pack or WebGL engine is required. The island scene is normal React + SVG + CSS, so it stays realistic for a Telegram Mini App and can be iterated without an artist pipeline.

### Mobile shell

- compact game HUD instead of dashboard widgets;
- Telegram group avatar/name plus ELO, member count and treasury;
- game-style bottom navigation with inline SVG icons;
- dark navy / ocean visual language;
- other screens inherit game cards instead of corporate SaaS panels.

### Own island

The own-island screen now uses the same reusable SVG island renderer as the world map, so the map and island-management screen have a consistent visual language.

## Island world rules

### One chat = one island

When an admin launches the Mini App from a Telegram group for the first time:

1. the state is created;
2. a permanent world coordinate is allocated;
3. Telegram title/avatar/member count are synchronized;
4. the island appears in the ocean.

The world does not have a fixed visible boundary. The client requests nearby islands for the current camera viewport.

### Island scale

Physical island size is derived from Telegram member count with a capped nonlinear scale. Small groups remain small; large communities become visually dominant without covering the whole screen.

## ELO and island campaigns

Island battles use ELO. Beating a stronger opponent is worth more; losing to a weaker opponent costs more.

The current campaign system also includes island integrity:

- attacks damage island infrastructure;
- an island is only destroyed when integrity reaches zero;
- destroyed islands become temporary ruins rather than being deleted;
- ruins disable attacks and heavily reduce production;
- recovery grants temporary protection against chain-farming;
- wins, losses, streaks and peak ELO remain in history.

## Realtime battle engine

Island invasion starts the existing 3-minute server-authoritative realtime battle:

- points A / B / C;
- assault / medic / engineer / scout;
- HP, kills, respawn and cooldowns;
- commander orders;
- Supabase Realtime;
- atomic PostgreSQL battle actions.

## Important technical fix in v1.1

A duplicated Supabase `.subscribe()` statement in the in-progress v1.0 branch was removed. The v1.1 sources pass parser-level syntax validation.

## Project structure

```text
app/
  api/
    game/
    telegram/
  globals.css
  game-theme.css        # v1.1 game-first visual layer

components/
  game-app.tsx
  game/
    island-art.tsx      # reusable SVG island renderer
    island-map.tsx      # infinite ocean / mobile world
    island-home.tsx
    island-ranking.tsx
    island-alliances.tsx
    battle-screen.tsx
    state-view.tsx

supabase/migrations/
  001_init.sql
  002_realtime_battles.sql
  003_commanders_squads.sql
  004_diplomacy_world_feed.sql
  005_daily_ops_guardrails.sql
  006_atomic_battle_actions.sql
  007_seasons_politics_identity.sql
  008_island_world_elo.sql
  009_island_integrity_campaigns.sql
```

## Supabase

Create a Supabase project and run migrations in numerical order through:

```text
009_island_integrity_campaigns.sql
```

Environment:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## Telegram

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
TELEGRAM_MINI_APP_SHORT_NAME=...
TELEGRAM_WEBHOOK_SECRET=...
```

The bot should be added to a group. Initial state creation must be launched by a group admin.

## Vercel

```bash
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
TELEGRAM_MINI_APP_SHORT_NAME=...
TELEGRAM_WEBHOOK_SECRET=...
NEXT_PUBLIC_DEMO_MODE=false
```

Then:

```bash
npm install
npm run build
npm run telegram:configure
```

For browser-only UI testing without Telegram/Supabase:

```bash
NEXT_PUBLIC_DEMO_MODE=true
```
