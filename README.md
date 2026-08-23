# GROUP WARS v1.5.0 — Full State Wars

Telegram-native strategy where every real Telegram group becomes an island-state in one persistent ocean world.


## v1.5.0: полный State Wars

Версия 1.5.0 реализует полный игровой слой из ТЗ поверх существующего realtime-океана и боёв A/B/C. Чат и Mini App используют одну серверную логику и одинаковые проверки прав.

- Типы войны: `raid` (15 мин), `territory` (20 мин), `siege` (30 мин).
- Размер государства считается по активным игрокам и развитию: `active_players^0.4 × level^0.6`.
- Большой атакующий получает до −30%, маленький защитник до +25%, агрессор до −15% за частые войны.
- Defensive Buffer зависит от заставы и репутации, с hard cap 20%.
- Союзная помощь реально входит в бой и ограничена 35% базовой силы стороны.
- Близкий результат с разницей меньше 5% становится настоящей ничьей.
- Захват бюджета и влияния ограничен, после поражения включается защитный период.
- Добавлены ежедневные активности с выбором, риском, последствиями и журналом вклада.
- Добавлены казначейство, академия, застава и торговая палата в стратегический слой.
- Остров новичков является обычным Telegram-государством с `BEGINNER_ISLAND_CHAT_ID`: максимум 5 уровень, куратор вместо президента, атаки запрещены, экономика/стоимости снижены на 40%, поддержка только обороны.
- Уход с Острова новичков даёт −10% к вкладу на 72 часа и cooldown смены государства 24 часа; возврат ограничен правилами ТЗ.
- Redis обязателен для rate limit и коротких action-lock через Upstash REST. PostgreSQL остаётся источником истины.
- Vercel Cron завершает истёкшие бои каждую минуту и отправляет итоги в Telegram-чаты.

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

Migration `013_full_state_wars_spec.sql` хранит все модификаторы непосредственно в Battle, чтобы результат можно было объяснить и воспроизвести.

```text
state_size = active_players ^ 0.4 × game_level ^ 0.6
attack_penalty = min(30%, 8% × max(0, log2(attacker_size / defender_size)))
underdog_bonus = min(25%, 7% × max(0, log2(attacker_size / defender_size)))
```

К расчёту также применяются Defensive Buffer, усталость агрессора, зафиксированные в записи боя случайные коэффициенты 0.85–1.15 и союзная поддержка с cap 35%. Победа с разницей менее 5% не назначается: это ничья, обе стороны платят восстановление, лута нет.

## Telegram text commands

Mini App является удобной панелью, а не отдельным набором возможностей. Основные действия полностью доступны из группового чата.

```text
!помощь
!профиль
!статус
!ресурсы
!вклад
!государства
!активность
!активность <ключ> <вариант>
!бой
!оборона
!улучшить <казначейство|казармы|шахта|нпз|ферма|академия|застава|торговая_палата>
!союз <ID_чата>
!союз принять <ID_чата>
!союз отклонить <ID_чата>
!союз выйти <ID_чата>
!война <ID_чата> <raid|siege|territory>
!поддержать <ID_боя> <attack|defense>
!сдаться [ID_боя]
```

Права проверяются именно в момент выполнения действия. Военные и дипломатические действия доступны президенту/заместителю; куратор действует только на Острове новичков и не может начинать атаку. Telegram callback-кнопки защиты, запроса союзной помощи и капитуляции проходят те же серверные проверки.

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

Fresh database: run `001` through `013` in order.

Existing project already on `012`: run only:

```text
supabase/migrations/013_full_state_wars_spec.sql
```

Migration `013` adds the strategic state fields, contribution ledger, daily activities, alliance/support models, Beginner Island citizenship rules, extra infrastructure, battle metadata, true draws, limited loot and post-battle recovery.

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

The v1.4.2 performance work is retained. v1.5.0 additionally requires migration `013`. Migration `013` adds the full state-war layer: balanced raid/siege/territory battles, strategic state stats, alliance support, contribution tracking, daily choice activities, Beginner Island rules, protected state transitions, capped loot, post-defeat shields and database-backed timed building upgrades. Building upgrades reserve resources atomically, take 2–45 minutes depending on target level and then enter a 5-minute cooldown.

## Environment

```bash
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
# Legacy alias is also supported:
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SECRET_KEY=...
# Legacy alias is also supported:
SUPABASE_SERVICE_ROLE_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=...
TELEGRAM_MINI_APP_SHORT_NAME=...
TELEGRAM_WEBHOOK_SECRET=...
BEGINNER_ISLAND_CHAT_ID=-1001234567890
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
CRON_SECRET=...
```

No demo environment variable is supported.

## Verify before deploy

The project includes `scripts/clean-legacy.mjs`. `npm run typecheck`, `npm run build` and `npm run dev` automatically remove the two files deleted since v1.3.1 (`lib/demo.ts` and the obsolete hex attack route), so extracting v1.4.2 over an older working tree cannot accidentally compile them.

```bash
npm install
npm run typecheck
npm run build
```

Then apply migration `013`, configure Upstash Redis + `CRON_SECRET`, deploy so Vercel registers `/api/cron/battles`, and configure the Telegram webhook:

```bash
npm run telegram:configure
```

## Important Telegram permissions

To create single-use recruitment invite links, the bot needs permission to invite users in participating groups.
