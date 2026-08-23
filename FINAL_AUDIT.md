# WARSTATE v1.6.0 — UI + project audit

This archive contains the current WARSTATE v1.6.0 project tree, based on the v1.5.0 gameplay build with a Mini App UI overhaul.


## UI overhaul in v1.6.0

- Replaced the font-rendered island-sheet close glyph with a symmetric two-path SVG icon.
- Removed the artificial outer device/frame look from the Mini App shell.
- Added Telegram WebApp chrome color synchronization through guarded SDK methods.
- Rebuilt header, stat chips, island labels, map tools, selected-island sheet and bottom navigation around translucent sea-glass surfaces.
- Reduced bottom navigation from seven cramped items to six primary destinations; Strategy remains accessible from Island through a dedicated HQ entry.
- Unified internal screen surfaces and spacing around the WARSTATE beach/island visual language.
- Updated user-facing brand strings and metadata to WARSTATE.

## Implemented in v1.5.0

- Unified state-war rules shared by Telegram chat commands and Mini App actions.
- Role checks at action execution time for president/deputy-controlled actions.
- Three battle types: raid, siege and territory.
- State-size balancing with a large-attacker penalty, small-defender bonus, defensive buffer and aggression fatigue.
- Strategic army/defense power now affects realtime scoring with bounded modifiers so capture-point play remains decisive.
- Alliance battle support with a 35% base-power cap and side-correct Telegram/Mini App actions.
- Draws for close battles, capped resource capture and a post-defeat protection shield.
- One authoritative loot path; the legacy destruction-loot path is disabled.
- Stored battle modifiers/random coefficients for transparent result reconstruction.
- Daily activities with player choices, risk/reward outcomes and contribution rewards.
- Contribution ledger and temporary contribution penalty after leaving Beginner Island.
- Beginner Island rules: level cap, reduced economy/costs, attack restrictions, curator role and training rewards.
- State-transition history and anti-abuse cooldowns, including protection against Freeport transition laundering.
- Timed, database-backed building upgrades with atomic cost reservation and cooldowns.
- Expanded buildings including outpost and trade chamber.
- Realtime island map exposes level, army, defense, active players, state size and global ranking.
- Telegram commands/actions for status, resources, contribution, activities, battles, upgrades, alliances, support and surrender.
- Automatic battle finalization endpoint for Vercel Cron.
- Optional Upstash Redis REST rate limiting and short-lived action locks while PostgreSQL remains the source of truth.
- Obsolete demo/legacy attack code removed and guarded by the prebuild cleanup script.

## Audit performed

- TypeScript/TSX syntax transpile audit after v1.6 UI changes: 56/56 source files passed.
- Local import resolution audit: no missing project-local imports.
- RPC contract audit: all 20 RPC names referenced by application code are defined in Supabase migrations.
- SQL migration `013_full_state_wars_spec.sql`: structural delimiter check passed and required functions are present.
- Environment-variable coverage: every application `process.env` reference is documented in `.env.example`.
- `git diff --check`: passed with no whitespace errors.
- Battle-formula sanity checks: caps and underdog/size/fatigue separation verified.
- Surrender path uses the same battle finalizer as normal resolution.
- Archive policy: `.env`, `.git`, `.next`, `node_modules`, build caches and local TypeScript build info are intentionally excluded.

## Build verification note

A dependency-resolved `npm run typecheck` / `npm run build` could not be executed in the audit container because the npm registry was unavailable and dependencies were not cached locally. Both online installation and offline-cache installation were attempted. Static TypeScript transpilation, import/RPC/environment checks and project integrity checks passed as described above.

For deployment, use Node.js 22, install dependencies, then run:

```bash
npm install
npm run typecheck
npm run build
```

Apply Supabase migrations through `013_full_state_wars_spec.sql`, configure the values listed in `.env.example`, configure Vercel Cron, and then configure the Telegram webhook with `npm run telegram:configure`.
