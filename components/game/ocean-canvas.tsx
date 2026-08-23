"use client";

import { memo, useEffect, useRef } from "react";

type Camera = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };
type Props = { camera: Camera; viewport: Size; reduced?: boolean };

function hash2(x: number, y: number) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function oceanTone(worldY: number) {
  const band = (Math.sin(worldY * 0.00042) + 1) * 0.5;
  const r = Math.round(8 + band * 7);
  const g = Math.round(104 + band * 24);
  const b = Math.round(137 + band * 21);
  return `rgb(${r},${g},${b})`;
}

function OceanCanvasInner({ camera, viewport, reduced = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  const reducedRef = useRef(reduced);

  useEffect(() => { cameraRef.current = camera; }, [camera.x, camera.y, camera.zoom]);
  useEffect(() => { viewportRef.current = viewport; }, [viewport.width, viewport.height]);
  useEffect(() => { reducedRef.current = reduced; }, [reduced]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let active = true;
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    const lowPower = cores <= 4;

    const draw = (time: number) => {
      if (!active) return;
      const reducedMotion = reducedRef.current;
      const targetFps = reducedMotion ? 12 : lowPower ? 20 : 28;
      const interval = 1000 / targetFps;
      if (time - last < interval) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = time;

      const { width, height } = viewportRef.current;
      if (width <= 0 || height <= 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const dpr = Math.min(lowPower ? 1.08 : 1.28, window.devicePixelRatio || 1);
      const pixelW = Math.max(1, Math.floor(width * dpr));
      const pixelH = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cam = cameraRef.current;
      const seconds = time / 1000;
      const worldLeft = cam.x - width / (2 * cam.zoom);
      const worldTop = cam.y - height / (2 * cam.zoom);
      const worldBottom = cam.y + height / (2 * cam.zoom);

      // The sea color itself is sampled from world Y. Even the broad depth
      // gradient therefore moves when the camera travels through the world.
      const background = ctx.createLinearGradient(0, 0, 0, height);
      background.addColorStop(0, oceanTone(worldTop));
      background.addColorStop(0.52, oceanTone(cam.y));
      background.addColorStop(1, oceanTone(worldBottom));
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      // Gerstner-inspired swell bands. We do not simulate particles: three
      // directional sine fields produce rolling crests in world coordinates,
      // which is visually convincing but cheap enough for Telegram WebView.
      const swellStep = reducedMotion ? 146 : 96;
      const sampleStep = lowPower || reducedMotion ? 68 : 48;
      const firstBand = Math.floor(worldTop / swellStep) * swellStep - swellStep * 2;
      const lastBand = worldBottom + swellStep * 2;
      ctx.lineCap = "round";

      for (let baseY = firstBand; baseY <= lastBand; baseY += swellStep) {
        ctx.beginPath();
        let first = true;
        for (let sx = -sampleStep; sx <= width + sampleStep; sx += sampleStep) {
          const wx = worldLeft + sx / cam.zoom;
          const y1 = Math.sin(wx * 0.0097 + baseY * 0.0019 + seconds * 0.56) * 8.8;
          const y2 = Math.sin(wx * 0.0042 - baseY * 0.0031 - seconds * 0.27) * 5.0;
          const y3 = Math.sin((wx + baseY) * 0.0022 + seconds * 0.18) * 2.8;
          const sy = (baseY + y1 + y2 + y3 - cam.y) * cam.zoom + height / 2;
          if (first) { ctx.moveTo(sx, sy); first = false; }
          else ctx.lineTo(sx, sy);
        }
        const noise = hash2(Math.floor(baseY / swellStep), 17);
        ctx.strokeStyle = `rgba(194,244,235,${(0.07 + noise * 0.085).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.8, 1.25 * cam.zoom);
        ctx.stroke();

        if (!reducedMotion && cam.zoom > 0.48 && noise > 0.58) {
          ctx.save();
          ctx.setLineDash([12 * cam.zoom, 17 * cam.zoom, 3 * cam.zoom, 20 * cam.zoom]);
          // Moving foam is relative to the world band, not to screen pixels.
          ctx.lineDashOffset = -(seconds * 7 + baseY * 0.075);
          ctx.strokeStyle = `rgba(255,253,236,${(0.09 + noise * 0.11).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.9, 1.55 * cam.zoom);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Smaller cross-waves are generated from an infinite world grid. Panning
      // exposes neighbouring cells, so the pattern never sticks to the camera.
      const cell = reducedMotion ? 138 : 104;
      const gx0 = Math.floor(worldLeft / cell) - 2;
      const gy0 = Math.floor(worldTop / cell) - 2;
      const gx1 = gx0 + Math.ceil(width / (cell * cam.zoom)) + 5;
      const gy1 = gy0 + Math.ceil(height / (cell * cam.zoom)) + 5;

      for (let gy = gy0; gy <= gy1; gy += 1) {
        for (let gx = gx0; gx <= gx1; gx += 1) {
          const random = hash2(gx, gy);
          const wx = gx * cell + 18 + random * 58;
          const wy = gy * cell + 14 + hash2(gy, gx) * 64;
          const sx = (wx - cam.x) * cam.zoom + width / 2;
          const sy0 = (wy - cam.y) * cam.zoom + height / 2;
          const phase = gx * 0.67 + gy * 0.43 + seconds * (reducedMotion ? 0.10 : 0.32);
          const sy = sy0 + Math.sin(phase) * 4.4 * cam.zoom;
          const len = (32 + random * 50) * cam.zoom;
          const amp = (2.4 + random * 4.1) * cam.zoom;
          if (sx < -len || sx > width + len || sy < -30 || sy > height + 30) continue;

          ctx.strokeStyle = `rgba(211,248,242,${(0.10 + random * 0.13).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.65, 1.15 * cam.zoom);
          ctx.beginPath();
          ctx.moveTo(sx - len / 2, sy);
          ctx.bezierCurveTo(sx - len * 0.20, sy - amp, sx + len * 0.16, sy + amp, sx + len / 2, sy - amp * 0.18);
          ctx.stroke();

          if (!reducedMotion && random > 0.84 && Math.sin(phase) > 0.58 && cam.zoom > 0.54) {
            ctx.strokeStyle = `rgba(255,253,237,${(0.19 + random * 0.20).toFixed(3)})`;
            ctx.lineWidth = Math.max(0.9, 1.5 * cam.zoom);
            ctx.beginPath();
            ctx.moveTo(sx - len * 0.18, sy - amp * 0.24);
            ctx.quadraticCurveTo(sx, sy - amp * 0.85, sx + len * 0.18, sy - amp * 0.14);
            ctx.stroke();
          }
        }
      }

      // Sparse world-space caustics add depth without a WebGL shader.
      if (!reducedMotion) {
        ctx.globalCompositeOperation = "screen";
        const anchorX = Math.floor(cam.x / 620) * 620;
        const anchorY = Math.floor(cam.y / 520) * 520;
        for (let i = 0; i < 6; i += 1) {
          const wx = anchorX + (i - 2.5) * 430 + hash2(i, Math.floor(anchorY / 520)) * 170;
          const wy = anchorY + ((i * 197) % 880) - 440;
          const sx = (wx - cam.x) * cam.zoom + width / 2;
          const sy = (wy - cam.y) * cam.zoom + height / 2;
          const radius = (86 + i * 11) * cam.zoom;
          const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
          glow.addColorStop(0, "rgba(121,231,220,.06)");
          glow.addColorStop(1, "rgba(121,231,220,0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.ellipse(sx, sy, radius, radius * 0.43, -0.28, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }

      raf = requestAnimationFrame(draw);
    };

    const visibility = () => {
      if (document.visibilityState === "hidden") {
        active = false;
        cancelAnimationFrame(raf);
      } else if (!active) {
        active = true;
        last = 0;
        raf = requestAnimationFrame(draw);
      }
    };

    document.addEventListener("visibilitychange", visibility);
    raf = requestAnimationFrame(draw);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="ocean-physics-canvas" aria-hidden="true" />;
}

export const OceanCanvas = memo(OceanCanvasInner);
