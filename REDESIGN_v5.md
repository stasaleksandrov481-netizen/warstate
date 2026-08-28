# WARSTATE v5 — Continental Redesign

## Implemented
- Replaced the ocean/island presentation with a continental state map and castle territories.
- Preserved three map LOD levels: compact state marker, state + leader summary, full state card.
- Added a first-run 4-step onboarding flow with Skip and persistent completion state.
- Added a new command-center home screen with large navigation tiles.
- Reworked primary Mini App palette toward dark brown, stone, dark green, gold and bronze.
- Replaced the island artwork with deterministic castle-region SVG artwork.
- Changed primary navigation vocabulary from Island to Castle / State and Battle to Army where appropriate.
- Removed remaining ocean / island / maritime copy from app, bot and gameplay messages.
- Rebuilt !помощь as an inline section menu with Back navigation.
- Added help sections: Castle, Army, Alliances, Decrees, Elections, Treasury, Roles, Emergencies.
- Changed emergency slots from every 3 hours to 5-hour daytime slots: 08:00, 13:00, 18:00; 10-minute response window remains.
- Kept server/database compatibility by retaining existing internal island-oriented identifiers and routes where renaming would require destructive migrations.

## Validation
- `node scripts/audit-project.mjs`: PASS
  - 76 source files scanned
  - 29 API routes
  - 37/37 referenced RPCs present
  - 44/44 required chat commands present
  - 104/104 aliases routed
- Focused TypeScript syntax check on changed TS/TSX files: no syntax diagnostics.
- Full `npm run typecheck` could not be completed in this sandbox because dependencies were not bundled in the source archive and package installation timed out before Next/React typings became available.

## Timezone note
Telegram does not expose a timezone for a group chat. Dynamic events continue to use `WARSTATE_TIMEZONE` (fallback `Europe/Moscow`). A true per-state timezone requires a stored state timezone plus a founder/admin setting flow.
