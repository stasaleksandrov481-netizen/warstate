# WARSTATE v5.4.0

## Map and Canvas
- Added 25% off-screen render buffer for state markers.
- Added buffered terrain rendering to reduce terrain redraws and pop-in while panning.
- Added shared sprite atlas for isometric castle bodies and tree sprites.
- Added requestAnimationFrame wheel throttling and throttled exploration loading.
- Added extreme far LOD with avatar/crest + state name only and anti-overlap clustering.
- Added single-state focus at maximum close zoom.
- Added context loss/restoration and page visibility redraw recovery to prevent black Canvas frames.

## Closed economy
- Personal coins and four-resource personal inventory.
- Role-based `!добыча` every 2 hours.
- `!сдать` resource selling into state treasury.
- Tools, House, consumables and personal shop.
- Noble titles and ELO investment sinks.
- Spy wild-land raid and Spy access to `!разведка`.
- Citizen-driven raw state resources and building gathering buffs.
- 50-unit humanitarian reserve and sleeping infrastructure anti-softlock.

## Help and UI
- Five-section `!помощь` inline menu using `editMessageText`.
- Expanded help coverage for the complete gameplay command set.
- Updated Mini App guide, personal wallet/inventory profile UI and state economy sleep feedback.
