# WARSTATE v5.3.1 map hotfix

- State inspector lowered and capped in height so it behaves like a bottom game sheet instead of covering the upper map.
- Camera is clamped to real world bounds. At world-fit zoom it stays centered and cannot fly into empty space.
- Inertia velocity is capped and damped at world boundaries.
- Canvas draw resets compositing/alpha each frame and falls back to the grass base if terrain paint fails.
- Canvas DPR capped at 1.6 to reduce GPU fill cost on mobile Telegram clients.
- Far-zoom decluttering is anchored to world coordinates, preventing castle representatives from flickering during pan.
- Nearby states are prefetched during motion with a 420 ms throttle, instead of only after pan ends.
- Castle renderer replaced with procedural isometric 2.5D architecture: front/top/side faces, towers, roofs, depth, flags and contact shadows.
- Far LOD keeps a cheaper isometric silhouette for FPS.
