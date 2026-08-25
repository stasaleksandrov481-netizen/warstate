# WARSTATE v3.6 Max

## What changed

- Unknown `!` messages are hard-ignored at the webhook boundary. Typos and commands for other bots no longer trigger WARSTATE error cards.
- Command parsing is case-insensitive, tolerates leading/trailing spaces and Russian `ё/е`, and includes aliases for ID, rewards, missions, buildings and version/health checks.
- Project audit now checks all registered command aliases, RPC existence, RPC argument names, unknown-command hard stop, compact-map migration and map overflow repairs.
- The island world is compacted from legacy 1800-unit spacing to a 520-unit golden-angle layout. Existing map slots are densified and future islands continue the same compact layout.
- `gw_get_islands` rank calculation is window-based instead of a correlated per-state count.
- Map camera defaults/limits were retuned, stale pre-migration camera positions are discarded, and four nearest islands are available as quick-focus buttons.
- Freeport and Beginner Island are always injected as global landmarks; radar has direct landmark shortcuts and can search by state name or `@username`.
- Fallback island loading now queries the camera area rather than an unrelated global top-120 list.
- Island labels/glows are no longer clipped by CSS paint containment.
- Profile content is denser: daily rewards and player progress appear near the top, active elections are surfaced early, panels and stat cards are shorter, and small-phone layouts are hardened.
- Radar and island detail sheets are height-bounded and scroll internally on short Telegram webviews.

## Database

Apply migrations in order. For an existing v3.5 database, apply:

1. `supabase/migrations/025_compact_world_and_map_repair.sql`

Migration 025 is idempotent and changes only map placement/indexing plus the world-read RPC implementation. State IDs and gameplay resources are untouched.

## Local checks performed

- `node scripts/audit-project.mjs`: OK
- 44/44 required commands present
- 85/85 registered command aliases routed
- 36/36 application RPCs found in migrations with argument-name validation
- TypeScript parser check on changed TS/TSX files: no syntax diagnostics
- CSS brace validation: balanced
