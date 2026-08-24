# WARSTATE v1.9.0 — Final Audit

## Scope

Final packaging audit for the Government & Chat Control update.

### Implemented in v1.9

- Automatic Telegram group registration through `my_chat_member` and self-healing registration on activity.
- Telegram chat creator is verified and stored as the permanent Founder.
- Explicit government roles: Founder, President, up to 3 Deputies, Citizen.
- 30-minute presidential elections with chat and Mini App voting by `@username`.
- Founder controls for president/deputies, state name and unique state username.
- Unique state usernames (`@north_empire`) usable for war, alliance, reconnaissance and search.
- Telegram chat title separated from the public in-game state name.
- Group-message activity reward: +2 player XP and +1 state contribution at most once per minute.
- Shared action layer for chat/Mini App war and building upgrades.
- Government Mini App API plus automatic election cron.
- Telegram webhook now subscribes to `callback_query` in addition to messages and membership changes.
- New state identity is displayed across state, map, ranking and diplomacy UI.

## Static checks

- `npm run audit:project`: PASS
- TypeScript/TSX syntax transpile: PASS (59/59 files)
- Local import resolution: PASS (covered by project audit)
- Environment variables: all referenced variables are documented in `.env.example`
- Application RPC calls: PASS (28/28 referenced RPCs exist in SQL migrations)
- Requested v1.9 chat command set: PASS (33/33 requested commands recognized)
- JSON configuration files: parse successfully
- Forbidden build/runtime folders and secret `.env` files: absent from release tree

## SQL migration

New migration:

`supabase/migrations/014_government_chat_control.sql`

It must be applied after migration `013_full_state_wars_spec.sql` on an existing database. A fresh database should apply migrations in numeric order through `014`.

## Build status

A full `npm install` / `next build` could not be completed in this container because DNS access to `registry.npmjs.org` returned `EAI_AGAIN`. No successful production build is claimed. Static TypeScript syntax checks and project-level consistency checks were run instead.

## Release hygiene

The final ZIP is created without `.env`, `.git`, `.next`, `node_modules`, `.vercel`, caches or temporary logs. The ZIP is then extracted into a clean verification directory and audited again before delivery.
