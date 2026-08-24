# WARSTATE v1.8.0 — FINAL AUDIT

WARSTATE v1.8.0 **Gameworld Update** is a full-project UI/world polish pass based on v1.7.0 World Command. It retains the v1.5 strategic/state-war layer and the v1.7 map/network UX work.

## Main v1.8 changes

### Close button fix

The island inspector close glyph no longer depends on a font `×` or SVG stroke rendering. `CloseIcon` renders a neutral span and CSS draws two identical centered bars with the same origin, dimensions and opposite ±45° rotations. The button itself is a 34×34 grid-centered control. This removes the asymmetric-looking X that appeared under Telegram WebView scaling.

### Motion and navigation

- Two-phase main-page transitions: leaving -> entering.
- Staggered card entrance for the new screen.
- Island inspector has independent open and close animations.
- Strategy tabs animate on selection.
- World pan keeps a short decaying inertia after finger release.
- Own island, radar result and mini-map navigation use smooth camera fly-to rather than snapping.
- Tactile press states are applied to game controls.
- Ambient world layer adds lightweight currents, gulls, sails and boat movement.
- `prefers-reduced-motion` disables optional animation for accessibility / weaker devices.

### Procedural island renderer

The near-detail island pass was substantially rebuilt while keeping deterministic state-ID generation and LOD limits:

- houses: individual wall/roof geometry, doors, windows, roof highlights and ground shadows;
- roads: shadow/underlay, surface and bright center marking;
- vegetation: tree shadows, trunks, multi-layer crowns and highlights;
- micro-detail: rocks, shrubs, individual grass strokes, flowers and palms;
- development detail: field rows and fences when the state reaches the relevant population range;
- coastline: stronger land contour / inner depth treatment;
- port: deeper pier geometry, lighting detail and animated boat.

The richer geometry is only enabled for near LOD. Far/mid map LODs remain reduced so a world containing many states does not attempt to render every grass blade simultaneously.

### Global game UI pass

The map and internal scenes share one updated dark tropical-command visual language. The pass touches:

- header/HUD and resource chips;
- bottom command dock;
- world controls, minimap and radar;
- island labels and selected-island inspector;
- My Island / Freeport scene;
- Strategy HQ tabs/cards;
- ranking / podium / league list;
- diplomacy and incoming proposals;
- profile and politics surfaces;
- battle HUD, event feed and actions;
- toast/loading/error states.

The heavy beige inspector is replaced by a darker semi-transparent game surface with clearer hierarchy and stronger action states.

## Audit performed on working tree

- `npm run audit:project`: **PASS**.
- Source files scanned by project audit: **58**.
- API routes found: **21**.
- Environment variables referenced/documented: **15**.
- TypeScript/TSX syntax transpile check: **55/55 PASS** using TypeScript transpile diagnostics.
- CSS parser check: `app/globals.css` **0 errors**, `app/game-theme.css` **0 errors**.
- Application RPC references: **20/20 found in Supabase migrations**.
- Missing local imports: **0** through the built-in project audit.
- Forbidden/legacy private paths checked by the audit.
- Secret-like literal scan outside SQL/docs: **no application credentials found**.
- Old v1.7 UI audit and local TypeScript build-info removed before packaging.

## Diff from v1.7

Source/docs package comparison for this pass: approximately **530 added / 141 removed lines** across the world renderer, island generator, app shell/navigation, strategy UI, motion CSS, audit script and documentation.

## Build verification note

A dependency-resolved `npm run typecheck` / `npm run build` cannot be truthfully marked as passed in this container because project `node_modules` are not available and npm package installation could not complete through the registry during the session. This is why the report distinguishes dependency-free syntax/import/RPC/CSS/integrity checks from a real Next.js build.

On a machine with npm registry access run:

```bash
npm install
npm run audit:project
npm run typecheck
npm run build
```

For an existing database already on migration 012, v1.8 still requires the v1.5 strategic migration `supabase/migrations/013_full_state_wars_spec.sql` if it has not already been applied.
