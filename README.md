# GROUP WARS v1.2.1 — Island World Polish

Telegram-native multiplayer strategy where **every Telegram group becomes a persistent island-state** on an expandable ocean.

Stack:

- Next.js 16 / React 19
- Vercel
- Supabase Postgres + Realtime
- Telegram Bot API + Mini App
- Telegram Stars foundation

## What changed in v1.2

This is a correctness + performance + mobile game-UI release, not a cosmetic version bump.

### Build / TypeScript fixes

- Fixed strict Supabase nullability that caused Vercel `TS18047: state is possibly null` errors.
- Added explicit guards around required `.single()` results instead of scattering unsafe non-null assertions.
- Added route validation for battle classes/actions, island coordinates and repair amount.
- Background state refreshes no longer leak transient network failures as unhandled promises.

### Island world

- One Telegram chat = one island-state.
- Island physical size scales nonlinearly with Telegram member count.
- Telegram avatar, title, members, ELO, integrity and relation status appear on-map.
- Infinite-feeling ocean with pan, pinch zoom, minimap and center-on-home.
- Nearby island queries are viewport-based rather than downloading the whole world.
- Island viewport query now has world-coordinate indexes and capped radius/result count.
- Removed the old per-island global-rank `COUNT` from map queries, which scaled badly as the world grew.

### Mobile game UI polish

- Compact HUD instead of SaaS KPI cards.
- Bottom navigation treats **Battle** as the primary action.
- SVG islands have coast variation, beaches, trees, houses, fortress, pier, flag, damage and ruins.
- Far zoom automatically drops expensive shadows, blur and decorative animations.
- Selected enemy opens a combat bottom-sheet with ELO stake, integrity and attack state.
- Own island screen is a command panel with upgrade/repair states, not a corporate dashboard.
- Better small-phone breakpoints and `prefers-reduced-motion` support.

### Island campaigns / ELO

- Battles affect ELO.
- Successful invasions damage island integrity rather than deleting an island in one match.
- At 0 integrity the island becomes temporary ruins.
- Ruined islands produce less, cannot attack and later recover to partial integrity with protection.
- Wins, losses, streak, best streak, peak ELO and badges persist.

### Battle correctness fixes

- Rejoining a battle can no longer heal the player back to 100 HP or reset respawn/position.
- Combat actions remain atomic in PostgreSQL.
- Battle reward delivery is now idempotent: a Vercel retry can finish a missed XP/contribution grant without duplicating it.
- High-frequency battle actions use a short Telegram membership-verification TTL instead of calling `getChatMember` on every tap.

### Telegram Stars hardening

- Product catalog is centralized in `lib/products.ts`.
- Pre-checkout validates SKU, Stars price, currency, Telegram user and entitlement scope.
- Successful-payment processing is retry-safe: duplicate Telegram updates do not duplicate payment rows, but can heal a partially-created entitlement.

## Project structure

```text
app/
  api/
    game/
    telegram/
  game-theme.css
  globals.css

components/
  game-app.tsx
  game/
    island-art.tsx
    island-map.tsx
    island-home.tsx
    island-ranking.tsx
    island-alliances.tsx
    battle-screen.tsx
    state-view.tsx

lib/
  battle.ts
  demo.ts
  diplomacy.ts
  elo.ts
  game.ts
  invariants.ts
  islands.ts
  missions.ts
  politics.ts
  products.ts
  request-auth.ts

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
  010_island_world_polish.sql
```

## Supabase upgrade

For a fresh database, run migrations `001` through `010` in order.

If your existing Supabase project already has v1.1 migrations through `009`, run only:

```text
supabase/migrations/010_island_world_polish.sql
```

## Environment variables

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

`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` are also supported by the Supabase helpers where configured.

## Local / Vercel verification

```bash
npm install
npm run typecheck
npm run build
```

Then configure the Telegram webhook after the public Vercel URL is live:

```bash
npm run telegram:configure
```

For browser-only UI testing without Telegram/Supabase:

```bash
NEXT_PUBLIC_DEMO_MODE=true
npm run dev
```

## Notes

- Production writes go through server routes and validate Telegram `initData`.
- Sensitive actions also verify current Telegram-group membership.
- The service-role key must never be exposed as `NEXT_PUBLIC_*`.
- No generated images are required for the island renderer; the map uses React + SVG + CSS so it stays lightweight and editable.

## v1.2.1 build fix

- Fixed invalid `typescript@5.8.0` dependency by pinning TypeScript to `5.9.2`.
- Pinned Vercel Node runtime to `22.x` instead of `>=22` to prevent automatic major-version jumps.

