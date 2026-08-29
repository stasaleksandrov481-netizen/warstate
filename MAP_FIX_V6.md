# WARSTATE map v6

- Replaced the transformed DOM/SVG world map with a single canvas renderer.
- Removed the giant 10,000x10,000 SVG alliance layer and giant transformed terrain DOM.
- Removed inverse/counter scaling of castle nodes that caused unstable GPU rasterization.
- Castles are rendered as larger beveled/isometric-style settlements with towers, walls, flags and shield/avatar.
- At the minimum zoom, castles remain approximately 112 CSS pixels tall/wide so they stay recognizable instead of becoming dots.
- Panning and pinch zoom repaint through requestAnimationFrame without React renders per pointer event.
- Canvas DPR is capped at 2 to keep mobile GPU/memory use sane.


## v5.2.0 additions

- Far view: explore radius raised from 6500 to 9000 to match DB limit; fitWorld now loads all states.
- Flicker: React re-renders removed from hot path (camera/size state updates only on LOD tier change).
- LOD: continuous marker scaling and smooth label alpha fade replace stepped far/mid/near thresholds.
- Territory: radial glow ring around settlements at mid+ zoom gives a sense of owned land.
- Performance: terrain gradient + patches cached to offscreen canvas, repainted only on significant camera change.
- Citizenship: bootstrapGame detects recent state switch and prefers player home_state_id over stale start_param.
- Bot spam: rate-limited bot-closed replies (1 per chat per 5 minutes) via maybeBotClosedReply().
