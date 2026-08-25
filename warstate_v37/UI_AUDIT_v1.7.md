# WARSTATE v1.7.0 — World Command UI/UX audit

## World map

- Added radar/search without replacing the direct drag/pinch map interaction.
- Added relation filters and visible/loaded counters.
- Made the minimap interactive and persisted camera position per state for the session.
- Tightened visible-island budgets to stop large explored worlds from ballooning the DOM.
- Preserved the selected and own island when culling whenever they remain in the candidate range.

## Telegram-native behavior

- Native BackButton follows the Mini App hierarchy.
- LIVE/OFF state is visible in the HUD and can be tapped for a manual sync.
- Returning to a visible Mini App schedules a state refresh.
- Success/error actions use Telegram notification haptics when available.
- Header/background/bottom chrome remains visually merged with the WARSTATE shell.

## Network resilience

- Client fetches use a 12-second request timeout.
- External aborts used by map exploration are preserved and do not become noisy timeout toasts.
- Offline state no longer pretends that realtime synchronization is active.

## Major screen upgrades

- HQ: overview, economy, live battle balance, activities, contribution history and ally support.
- Island: production, resources, development progress and construction state.
- Ranking: podium, search and own-rank summary.
- Diplomacy: relationship KPIs, incoming decisions and clearer active relationships.
- Battle: proportional score bar, player/capture KPIs, result card, loot summary and timestamped feed.

## Performance

- Ocean DPR/FPS budgets were reduced for mobile WebView use.
- Fine-ripple work is suspended during gestures.
- Map world transforms remain imperative while React state stays throttled for culling/UI.
- Island DOM count is bounded by zoom/detail level.

## Known platform boundary

The top-right Telegram Mini App menu and system close button are rendered by Telegram itself. WARSTATE can match native chrome colors but cannot change the geometry of Telegram's own close glyph. In-app close controls use the corrected symmetric SVG from v1.6.
