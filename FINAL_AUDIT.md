# WARSTATE v1.7.0 — final project audit

This archive contains WARSTATE v1.7.0 (World Command Update), based on the v1.6.0 UI build and retaining the v1.5.0 state-war gameplay layer.

## Major v1.7 changes

- World radar with state search and relation filters.
- Clickable minimap, session camera persistence and stronger island culling/DOM budgets.
- Lower-cost ocean rendering for Telegram WebView during pan/pinch and idle animation.
- LIVE/OFFLINE connection state, manual sync, refresh on app visibility restore and Telegram BackButton integration.
- 12-second client request timeout with mobile-network recovery messaging.
- Typed info/success/error toast system with Telegram haptic feedback.
- Strategy HQ rebuilt into Overview / Activities / Balance / Contribution tabs.
- State-home economy dashboard with production, development progress and construction state.
- Ranking redesign with TOP-3 podium, search and own-rank card.
- Diplomacy dashboard with KPIs and incoming request inbox.
- Battle HUD redesign with score-share bar, team KPIs, result summary, captured-resource output and larger event feed.
- Russianized request-auth errors and safer HTTP error inference.
- Built-in dependency-free `npm run audit:project` integrity checker.

## Audit performed

- TypeScript/TSX syntax transpile check: 55/55 application TS/TSX files passed.
- Project-local import resolution: 0 missing imports.
- Supabase RPC contract audit: all 20 RPC names referenced by application code exist in migrations.
- API route inventory: 21 route handlers.
- CSS structural check: opening/closing brace counts match.
- `npm run audit:project`: passed; scans source imports, referenced ENV variables, package identity and forbidden legacy/private paths.
- Environment coverage: all application ENV references other than platform-provided `NODE_ENV` are represented in `.env.example`.
- Legacy demo paths remain absent (`lib/demo.ts`, legacy `/api/game/attack`).
- Secret-like source scan found no embedded application credentials; SQL `service_role` hits are grants, not keys.
- Final archive policy excludes `.env`, `.env.local`, `.git`, `.next`, `node_modules`, `.vercel`, caches and TypeScript build info.

## Build verification note

A dependency-resolved `npm run typecheck` / `npm run build` still cannot be truthfully marked as passed in this container unless npm dependencies can be installed. The final packaging step attempts installation once with a bounded network timeout. Static syntax/import/RPC/environment/CSS/integrity checks are performed independently and are listed above.

For deployment with network access:

```bash
npm install
npm run audit:project
npm run typecheck
npm run build
```

For an existing database already on migration 012, apply `supabase/migrations/013_full_state_wars_spec.sql`. Configure `.env.example`, Vercel Cron and then run `npm run telegram:configure`.
