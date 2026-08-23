"use client";

import { memo, useEffect, useRef } from "react";

type Camera = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };
type LiveRef<T> = { current: T };
type Props = {
  cameraRef: LiveRef<Camera>;
  viewport: Size;
  interactingRef?: LiveRef<boolean>;
  reduced?: boolean;
};

type WaveTile = { canvas: HTMLCanvasElement; size: number };

function hash2(x: number, y: number) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function tone(worldY: number) {
  const band = (Math.sin(worldY * 0.00033) + 1) * 0.5;
  return {
    top: `rgb(${Math.round(9 + band * 5)},${Math.round(112 + band * 15)},${Math.round(145 + band * 17)})`,
    bottom: `rgb(${Math.round(5 + band * 4)},${Math.round(78 + band * 15)},${Math.round(116 + band * 18)})`,
  };
}

function makeWaveTile(size: number, seed: number, fine: boolean): WaveTile {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return { canvas, size };

  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const rows = fine ? 14 : 9;
  const cols = fine ? 9 : 7;
  for (let row = -1; row <= rows; row += 1) {
    const yBase = ((row + 0.5) / rows) * size;
    for (let col = -1; col <= cols; col += 1) {
      const r = hash2(seed + col, row - seed);
      if (r < (fine ? 0.25 : 0.12)) continue;
      const x = ((col + 0.35 + r * 0.55) / cols) * size;
      const y = yBase + (hash2(row + seed * 3, col) - 0.5) * (fine ? 26 : 40);
      const length = (fine ? 24 : 54) + r * (fine ? 42 : 72);
      const amp = (fine ? 2.2 : 4.5) + r * (fine ? 3.5 : 6.5);
      const tilt = (hash2(col * 7, row * 11 + seed) - 0.5) * (fine ? 0.20 : 0.34);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.moveTo(-length / 2, 0);
      ctx.bezierCurveTo(-length * 0.22, -amp, length * 0.12, amp * 0.8, length / 2, -amp * 0.10);
      ctx.strokeStyle = fine ? `rgba(185,239,235,${0.09 + r * 0.10})` : `rgba(166,232,228,${0.12 + r * 0.12})`;
      ctx.lineWidth = fine ? 1.1 : 1.55;
      ctx.stroke();

      if (r > (fine ? 0.80 : 0.68)) {
        ctx.beginPath();
        ctx.moveTo(-length * 0.18, -amp * 0.2);
        ctx.quadraticCurveTo(0, -amp * 0.85, length * 0.2, -amp * 0.12);
        ctx.strokeStyle = `rgba(255,252,231,${fine ? 0.15 : 0.22})`;
        ctx.lineWidth = fine ? 0.8 : 1.05;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Cheap caustic patches baked into the texture so no radial gradients are
  // created every frame.
  if (!fine) {
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < 8; i += 1) {
      const r = hash2(seed * 13 + i, i * 17);
      const x = r * size;
      const y = hash2(i * 19, seed * 7) * size;
      ctx.strokeStyle = `rgba(102,220,215,${0.035 + r * 0.035})`;
      ctx.lineWidth = 8 + r * 10;
      ctx.beginPath();
      ctx.ellipse(x, y, 28 + r * 45, 9 + r * 15, -0.3 + r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  return { canvas, size };
}

function fillWorldPattern(
  ctx: CanvasRenderingContext2D,
  pattern: CanvasPattern | null,
  width: number,
  height: number,
  camera: Camera,
  driftX: number,
  driftY: number,
  alpha: number,
) {
  if (!pattern) return;
  const zoom = Math.max(0.28, camera.zoom);
  const tx = width / 2 - (camera.x + driftX) * zoom;
  const ty = height / 2 - (camera.y + driftY) * zoom;
  pattern.setTransform(new DOMMatrix([zoom, 0, 0, zoom, tx, ty]));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;
}

function OceanCanvasInner({ cameraRef, viewport, interactingRef, reduced = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef(viewport);
  const reducedRef = useRef(reduced);

  useEffect(() => { viewportRef.current = viewport; }, [viewport.width, viewport.height]);
  useEffect(() => { reducedRef.current = reduced; }, [reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;

    const swellTile = makeWaveTile(512, 41, false);
    const rippleTile = makeWaveTile(384, 97, true);
    const swellPattern = ctx.createPattern(swellTile.canvas, "repeat");
    const ripplePattern = ctx.createPattern(rippleTile.canvas, "repeat");
    let raf = 0;
    let lastDraw = 0;
    let hidden = false;
    let lastToneBand = Number.NaN;
    let cachedGradient: CanvasGradient | null = null;
    let cachedVeil: CanvasGradient | null = null;
    let cachedWidth = 0;
    let cachedHeight = 0;
    const cores = navigator.hardwareConcurrency || 4;
    const lowPower = cores <= 4;

    const ensureSize = (width: number, height: number) => {
      // A high DPR is wasted on animated water and is one of the largest GPU
      // costs inside Telegram WebView. 1.15 still looks crisp under the SVG UI.
      const dpr = Math.min(lowPower ? 1 : 1.15, window.devicePixelRatio || 1);
      const pixelW = Math.max(1, Math.round(width * dpr));
      const pixelH = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        cachedGradient = null;
        cachedVeil = null;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time: number) => {
      if (hidden) return;
      const { width, height } = viewportRef.current;
      if (width <= 0 || height <= 0) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const interacting = Boolean(interactingRef?.current);
      // Panning must visually track the finger at display refresh rate. Idle
      // water can animate slower to save battery.
      const targetFps = interacting ? 60 : reducedRef.current ? 18 : lowPower ? 24 : 32;
      const interval = 1000 / targetFps;
      if (time - lastDraw < interval) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastDraw = time;
      ensureSize(width, height);

      const camera = cameraRef.current;
      const toneBand = Math.round(camera.y / 420);
      if (!cachedGradient || cachedWidth !== width || cachedHeight !== height || toneBand !== lastToneBand) {
        const colors = tone(camera.y);
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, colors.top);
        gradient.addColorStop(1, colors.bottom);
        cachedGradient = gradient;
        cachedWidth = width;
        cachedHeight = height;
        lastToneBand = toneBand;
      }
      ctx.fillStyle = cachedGradient ?? "#0b7899";
      ctx.fillRect(0, 0, width, height);

      const seconds = time * 0.001;
      // Two cached wave fields move at different velocities. Both remain
      // anchored in world coordinates, so camera movement never feels like the
      // ocean is glued to the screen.
      fillWorldPattern(ctx, swellPattern, width, height, camera, seconds * 5.5, seconds * 1.6, reducedRef.current ? 0.54 : 0.86);
      if (!reducedRef.current || interacting) {
        fillWorldPattern(ctx, ripplePattern, width, height, camera, -seconds * 8.2, seconds * 3.1, lowPower ? 0.46 : 0.62);
      }

      // A cheap horizon/depth veil keeps the water dimensional without any
      // per-frame blur/filter passes.
      if (!cachedVeil) {
        const veil = ctx.createLinearGradient(0, 0, width, height);
        veil.addColorStop(0, "rgba(255,255,255,.018)");
        veil.addColorStop(0.52, "rgba(255,255,255,0)");
        veil.addColorStop(1, "rgba(1,35,61,.10)");
        cachedVeil = veil;
      }
      ctx.fillStyle = cachedVeil ?? "rgba(1,35,61,.08)";
      ctx.fillRect(0, 0, width, height);

      raf = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      hidden = document.visibilityState === "hidden";
      if (hidden) cancelAnimationFrame(raf);
      else {
        lastDraw = 0;
        raf = requestAnimationFrame(draw);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(draw);
    return () => {
      hidden = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cameraRef, interactingRef]);

  return <canvas ref={canvasRef} className="ocean-physics-canvas" aria-hidden="true" />;
}

export const OceanCanvas = memo(OceanCanvasInner);
