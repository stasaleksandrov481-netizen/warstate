# WARSTATE v5.3.0 audit and fixes

## Fixed

- Map castles are rendered in screen space at a stable visual size. Camera zoom changes world distances, not castle scale.
- Far zoom uses screen-space decluttering/clustering and a cheap castle renderer to prevent overlap and reduce draw cost.
- Maximum zoom-out range was expanded (`MIN_ZOOM = 0.045`) so world-fit can show a much larger part of the continent.
- Map renderer now uses world-anchored terrain/grass. No camera-anchored terrain cache remains.
- Removed broken legacy terrain-cache references (`needTerrainRepaint`, `terrainCanvasRef`, `terrainKeyRef`).
- Drag/pan and click are separated by pointer-specific movement thresholds. Pinch gestures cannot trigger state selection.
- Added inertial camera movement and eased camera focus/fit transitions.
- State username is always shown in the state inspector; labels/search show it when available.
- Telegram Mini App layout uses SafeAreaInset + ContentSafeAreaInset (JS + official CSS vars) to avoid native-header overlap.
- Collapsed conflicting legacy header heights into two predictable layouts (desktop/tablet and narrow mobile).
- Removed duplicated `lastSyncAt` React state declaration from `components/game-app.tsx`.
- Added interstate messaging: `!соо @state_username text`.
- Added exact Telegram Reply routing for interstate messages using `chat_id + message_id` persisted in PostgreSQL.
- Added reply-chain support, message length validation and anti-spam cooldowns.
- Added messaging discoverability to Diplomacy UI and the game guide.

## Database

Apply migrations in order through:

`supabase/migrations/039_interstate_messages.sql`

Migration 039 adds the `state_messages` reply-routing table and indexes.

## Validation performed in this environment

- `npm run audit:project` passes.
- TypeScript parser scan passes for every `.ts` / `.tsx` source file.
- Global TypeScript semantic scan shows no new TS2304/TS2339-style structural errors; remaining compiler output is caused by unavailable npm type packages in this container.
- `npm ci` was attempted but the npm registry is unreachable from this execution environment, so a real `next build` cannot be claimed as passed here.
