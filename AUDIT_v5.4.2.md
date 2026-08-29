# WARSTATE v5.4.2 final release audit

This pass re-audits the v5.4 economy, Telegram bot, administration tools, Canvas map and Mini App UI as a release candidate.

## Real defects found and fixed in the final pass

- Fixed `scripts/audit-project.mjs` itself: duplicated `gameAppSource` / `mapSource` declarations prevented the strengthened audit from running.
- Added an API trust-boundary audit: game routes must use Telegram authorization, project-admin routes require both initData session and project-admin identity, cron endpoints require `CRON_SECRET`, and the webhook must validate Telegram's secret-token header.
- Added `043_release_final_hardening.sql` and revoked client access to internal SECURITY DEFINER trigger helpers (`gw_prepare_battle_strategy`, `gw_apply_admin_xp_boost`, `gw_enforce_state_resource_floor`).
- Added a generalized audit that fails if a SECURITY DEFINER function is introduced without an explicit client revoke.
- Bounded the decoded Telegram avatar cache on the Canvas map, evicts old entries, drops broken images and clears the cache on unmount. This prevents long exploration sessions from accumulating an unlimited number of decoded images in Telegram WebView memory.
- Fixed administration member search for medals/titles. A searched citizen is now resolved first and intersected with the selected state's membership, instead of being limited to an arbitrary first page of `state_members`.
- Added player search UI to the reward center so large states can actually target any matching citizen.
- Added the final UI alignment layer: larger secondary text, consistent touch targets, gutters, form sizing, state sheet typography, economy blocks and admin controls.
- Updated stale documentation and private-group access comments so they describe the actual owner/admin Reply flow rather than bot-minted admin invites.

## Checks passed

- `npm run audit:project`: OK
- 87 source files scanned by the project audit
- 32 API routes found and trust-boundary checked
- 49/49 referenced RPCs found in migrations
- 54/54 required Telegram commands present
- 126/126 registered command aliases routed
- TypeScript parser: 86 TS/TSX files, 0 syntax errors
- Structural TypeScript semantic pass with local external-module stubs: 0 errors
- SECURITY DEFINER revoke scan: 0 missing revokes across the final migration set
- CSS brace/delimiter check: OK
- SQL dollar-quote check: OK
- package/package-lock version: 5.4.2

## Build limitation of this audit environment

A real Next.js production build cannot be executed here because the npm cache does not contain `undici-types-6.21.0.tgz`; `npm ci --offline` fails with `ENOTCACHED`. Run the normal production validation in the deployment environment before promotion:

```bash
npm ci
npm run audit:project
npm run typecheck
npm run build
```

No static audit can prove that software contains literally zero runtime defects on every Telegram client. The release has been hardened against every reproducible/static issue found in this pass, and the known high-risk bug classes are now encoded into the permanent audit script.
