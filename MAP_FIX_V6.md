# WARSTATE map v6

- Replaced the transformed DOM/SVG world map with a single canvas renderer.
- Removed the giant 10,000x10,000 SVG alliance layer and giant transformed terrain DOM.
- Removed inverse/counter scaling of castle nodes that caused unstable GPU rasterization.
- Castles are rendered as larger beveled/isometric-style settlements with towers, walls, flags and shield/avatar.
- At the minimum zoom, castles remain approximately 112 CSS pixels tall/wide so they stay recognizable instead of becoming dots.
- Panning and pinch zoom repaint through requestAnimationFrame without React renders per pointer event.
- Canvas DPR is capped at 2 to keep mobile GPU/memory use sane.
