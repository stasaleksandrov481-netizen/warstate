# WARSTATE v5.4.0 implementation audit

## Canvas and map

- 25% off-screen render/culling buffer for states.
- 25% buffered terrain canvas reused while panning.
- Shared Canvas sprite atlas for castle LOD sprites and trees.
- Wheel input is coalesced through requestAnimationFrame.
- State exploration/network loading is throttled while the camera moves.
- Extreme far LOD renders only state avatar/crest, name and cluster counter.
- Anti-overlap remains world-cell anchored to avoid marker flicker during pan.
- Maximum close zoom focuses a single state and castle size remains clamped.
- Canvas handles context loss/restoration, pageshow, visibility return and resize redraw.
- Render exceptions fall back to a valid terrain frame instead of leaving a black canvas.

## Closed economy

- Personal wallet and personal inventory are separate from state treasury.
- `!добыча` has a two-hour cooldown and role-specific yields.
- No-role players receive a minimal baseline yield.
- `!сдать` transfers personal resources to state treasury and pays personal coins.
- Diplomat receives +10% sell price; active Trade Chamber adds a level bonus.
- State buildings buff citizen gathering while infrastructure is active.
- Personal tools have 25 uses; House produces hourly personal coins.
- Consumables reset gathering cooldown or provide a temporary +50% gathering boost.
- Baron, Count and Magnate titles are personal coin sinks.
- `!инвестировать` burns personal coins for controlled state ELO growth with a daily limit.
- Spy has a 15% wild-land raid and may use `!разведка`.
- State treasury has a hard 50-unit reserve across Credits, Steel, Fuel, Food and Tech.
- Insufficient upkeep switches infrastructure to sleeping mode instead of destroying buildings.
- Construction, repair and legacy spy treasury operations respect the reserve.

## Help and Mini App

- `!помощь` uses one Telegram message and `editMessageText` for navigation.
- Five requested help categories are present.
- Help content documents the complete gameplay command surface, including economy and role-specific commands.
- Mini App guide is synchronized with the v5.4 economy.
- Player profile displays wallet, inventory, tool, House, gathering cooldown and noble title.
- State screens visibly explain sleeping infrastructure and citizen-driven raw resources.

## Validation performed in this workspace

- `npm run audit:project`: PASS.
- TypeScript/TSX parser scan: PASS, 0 syntax errors.
- No-resolve TypeScript structural scan of changed files: no TS2304 / TS2451 / TS2339 / TS2552 structural errors after filtering unavailable external dependency types.
- Full Next.js production build requires installed npm packages and was not claimed as passed in this workspace.
