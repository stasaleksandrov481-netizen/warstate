# GROUP WARS v1.4.2 — Performance + Procedural World Polish

Telegram-native strategy where every real Telegram group becomes an island-state in one persistent ocean world.

## Stack

- Next.js 16 / React 19 / TypeScript
- Vercel
- Supabase Postgres + Realtime
- Telegram Bot API + Mini App
- Telegram Stars foundation

## v1.4: live-only Telegram

There is no browser demo mode, local substitute snapshot or localStorage game state.

The Mini App requires valid Telegram `initData`. Server routes validate its signature with `TELEGRAM_BOT_TOKEN`.

- Open without a group `start_param` → the real Supabase **Freeport** state.
- Open from a registered Telegram group → membership is checked with Bot API and the player is attached to that real state.
- The first launch of a new group must be made by a Telegram administrator/creator.
- Group title, avatar and member count are synchronized from Telegram.
- Sensitive actions re-check Telegram membership.

## Freeport

Freeport is a real neutral state at world coordinates `0, 0`.

- No president and no player-owned treasury progression.
- Cannot attack and cannot be attacked.
- New solo players start there.
- Open recruitment posts from real group-states are visible in Freeport.
- A Freeport player can apply to a state.
- State command can send an offer to a Freeport player.
- Accepted recruitment creates a one-use Telegram group invite through `createChatInviteLink`.
- Citizenship only changes after Telegram membership is actually verified.

## Procedural island world

Island geometry is deterministic from the state ID.

- Coastline shape is procedural.
- Physical island footprint grows with real Telegram member count.
- Residential lots are generated on a collision-safe staggered grid.
- Civic plaza and port corridor are hard no-build zones.
- All land decorations are clipped to the generated land mask, so houses cannot render in water.
- Near zoom draws individual houses with compound SVG paths. Mid/far zoom uses LOD to keep Telegram WebView responsive.
- Roads, trees, HQ, watch structures, warehouse, lighthouse, park, market, pier and boat appear as the community grows.

Conceptually one Telegram member owns one deterministic house lot. Large-group LOD affects rendering only, not population/state size.

## World-space ocean

The ocean is a lightweight Canvas renderer, not a fixed wallpaper. v1.4.2 rewrites the hot path for camera movement.

- Camera position comes from a live ref, so water follows the finger without waiting for React renders.
- During panning/pinch the canvas targets 60 FPS; idle animation drops to an adaptive 18–32 FPS to save battery.
- Wave fields are pre-rendered into reusable transparent tiles and moved in world coordinates with `CanvasPattern.setTransform`.
- Expensive per-frame radial gradients, nested wave sampling loops and repeated pattern creation were removed.
- Canvas DPR is capped at 1.0–1.15 because animated water does not benefit from full 2x/3x phone DPR.
- Broad depth color is cached by world band instead of rebuilt on every tiny movement.
- The island world layer moves imperatively on `requestAnimationFrame`; React camera state is throttled to culling/minimap/UI work only.
- Pointer movement no longer calls `getBoundingClientRect()` every event; the viewport rect is cached for the gesture.
- Rendering pauses when the document is hidden.


## Battle balance

Migration `011` persists transparent modifiers on every island battle.

Approximate state size:

```text
member_count ^ 0.4 × HQ_level ^ 0.6
```

When a larger state attacks a smaller state:

- attacker efficiency can be reduced by up to 30%;
- smaller defender efficiency can increase by up to 25%;
- defender receives an HQ-based starting defense buffer;
- repeated aggression in the last 7 days can reduce attack efficiency by up to another 15%.

The modifiers are stored in the battle row and shown in the battle UI.

## Telegram text commands

Mini App is a convenient interface; core state actions are also available in the group chat.

```text
!помощь
!статус
!ресурсы
!активность
!улучшить <штаб|казармы|шахта|нпз|ферма|лаборатория>
!союз <ID_чата>
!война <ID_чата>
```

Role checks happen when a command is executed. Battle/diplomacy/upgrade commands verify real state membership and permissions.

## UI changes

- Removed neon / SaaS-style primary surfaces.
- System UI typography replaces the cramped Trebuchet pass; headings, state names and navigation labels are larger.
- Header is a roomy two-row game HUD with three equal resource/status chips.
- All six bottom-navigation buttons have equal visual weight; Battle is not a special red CTA.
- Active navigation uses the same parchment/gold language as the rest of the game.
- Island labels are now large game banners with a 50px avatar, league/freeport kicker, rank, population and ELO.
- Enemy/selected island sheet is larger and easier to read.
- Map controls and minimap use one consistent cartoon surface language.
- Ranking, diplomacy, infrastructure, recruitment and battle cards were normalized to the same chunky parchment/teal visual system.
- Freeport uses the same island/world visual system as all other states.


## Supabase migrations

Fresh database: run `001` through `012` in order.

Existing project already on `010`: run, in order:

```text
supabase/migrations/011_freeport_live_recruitment.sql
supabase/migrations/012_live_integrity_audit.sql
```

If `011` is already applied, run only `012_live_integrity_audit.sql`. Migration `012` enforces one active citizenship per player, deduplicates old memberships, adds the atomic citizenship RPC and re-locks battle RPC privileges to the service role.

v1.4.2 intentionally has no database data fallbacks for missing migrations.

## v1.4.1 audit hardening (retained in v1.4.2)

- Telegram webhook is fail-closed when the webhook secret is missing or wrong.
- Successful Stars payments fail loudly and return HTTP 500 on database/entitlement failure so Telegram can retry an idempotent charge instead of losing paid access.
- Telegram `auth_date` rejects expired and implausibly future init data.
- State actions periodically re-verify real Telegram membership.
- Citizenship moves are atomic through `gw_set_player_home_state`; one player cannot keep multiple active states.
- Recruitment decisions are guarded against stale/concurrent pending requests.
- Election actions cannot be pointed at another state's election through a forged request.
- The old hex attack API and empty `tiles` payload were removed.
- Recent-war UI is backed by real island battles instead of an always-empty placeholder array.
- Required Supabase errors are no longer silently swallowed. Telegram notifications remain best-effort after a committed game action and are logged on failure.
- Duplicate shoreline render pass was removed from procedural island art.


## v1.4.2 performance pass

The performance work is deliberately architectural rather than a CSS-only tweak.

- Camera motion updates the world transform directly at animation-frame speed.
- React camera commits are limited to roughly every 96 ms while moving, enough for culling without rerendering the whole map at 60 Hz.
- Minimap points are suspended while dragging and capped at 96 when idle.
- The local island cache keeps at most 420 explored islands instead of 700.
- Map LOD is stricter: initial/medium zoom uses a light city representation; full micro detail is reserved for close zoom.
- Map city rendering is capped at 3,600 individual compound-path houses near and 760 at mid zoom; the deterministic lot model still represents the full Telegram population.
- The own-island view raises the city-detail budget to 6,000 individual homes, while larger populations remain deterministic but are visually grouped into districts so a 50k-member chat cannot freeze Telegram WebView.
- House geometry is cached with a small LRU so revisiting an island does not regenerate the same city.
- Large-city capacity checks no longer sort arrays on every spacing pass.
- Tree crowns/trunks are batched into compound SVG paths rather than dozens of React nodes.
- Procedural roads, rocks, shrubs and field rows add detail using a handful of SVG paths.
- Expensive SVG drop-shadow/blur filters and per-island foam animations are disabled on the world map; visual depth comes from layered shapes and shadows instead.

No new Supabase migration is required for v1.4.2. Keep migrations `001`–`012` from v1.4.1.

## Environment

```bash
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
TELEGRAM_MINI_APP_SHORT_NAME=...
TELEGRAM_WEBHOOK_SECRET=...
```

No demo environment variable is supported.

## Verify before deploy

The project includes `scripts/clean-legacy.mjs`. `npm run typecheck`, `npm run build` and `npm run dev` automatically remove the two files deleted since v1.3.1 (`lib/demo.ts` and the obsolete hex attack route), so extracting v1.4.2 over an older working tree cannot accidentally compile them.

```bash
npm install
npm run typecheck
npm run build
```

Then configure the Telegram webhook:

```bash
npm run telegram:configure
```

## Important Telegram permissions

To create single-use recruitment invite links, the bot needs permission to invite users in participating groups.
