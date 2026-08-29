"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import Image from "next/image";
import type { GameSnapshot, IslandView, WarType } from "@/lib/types";
import { stateMarkText } from "@/lib/visual";

const MIN_ZOOM = 0.16;
const MAX_ZOOM = 1.8;
const DEFAULT_ZOOM = 0.62;

type Camera = { x: number; y: number; zoom: number };
type MapFilter = "all" | "enemy" | "ally" | "neutral";

type Props = {
  snapshot: GameSnapshot;
  selected: IslandView | null;
  onSelect: (state: IslandView | null) => void;
  onAttack: (state: IslandView, battleType: WarType) => void;
  onSwitchState: (state: IslandView) => void;
  onExplore?: (x: number, y: number, radius: number) => void;
  onOpenBattle?: () => void;
  onOpenIsland?: () => void;
};

const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

function displayName(state: IslandView) {
  if (state.isFreeport) return "Нейтральная зона";
  if (state.isBeginnerIsland) return "Учебный округ";
  return state.name;
}

function timeLeft(iso?: string | null, now = Date.now()) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  return minutes > 59 ? `${Math.floor(minutes / 60)}ч ${minutes % 60}м` : `${minutes}м`;
}

function attackReason(snapshot: GameSnapshot, target: IslandView, now: number) {
  if (target.isMine) return "Это ваше государство";
  if (snapshot.state.isFreeport) return "Нейтральная зона не участвует в войнах";
  if (snapshot.state.isBeginnerIsland) return "Из учебного округа нельзя начинать войну";
  if (target.isFreeport) return "Нейтральная зона защищена";
  if (target.isBeginnerIsland) return "Учебный округ защищён";
  if (snapshot.player.role !== "president") return "Голосование о войне запускает Президент";
  if (snapshot.activeBattle) return "Государство уже участвует в бою";
  if (snapshot.state.destroyedUntil && new Date(snapshot.state.destroyedUntil).getTime() > now) return "Государство восстанавливается";
  if (target.destroyedUntil && new Date(target.destroyedUntil).getTime() > now) return "Цель восстанавливается";
  if (target.shieldUntil && new Date(target.shieldUntil).getTime() > now) return "У цели действует защита";
  if (target.relation === "allied") return "Это союзное государство";
  if (target.relation === "truce") return "Действует перемирие";
  if (snapshot.state.nextAttackAt && new Date(snapshot.state.nextAttackAt).getTime() > now) return `Армия готовится · ${timeLeft(snapshot.state.nextAttackAt, now) || "скоро"}`;
  if (snapshot.state.treasury.fuel < 120 || snapshot.state.treasury.food < 80) return "Нужно 120 топлива и 80 еды";
  return null;
}

function relationText(state: IslandView) {
  if (state.isMine) return "Ваше государство";
  if (state.isFreeport) return "Нейтральная зона";
  if (state.isBeginnerIsland) return "Защищённый округ";
  if (state.relation === "war") return "Военный противник";
  if (state.relation === "allied") return "Союзник";
  if (state.relation === "truce") return "Перемирие";
  return "Нейтральные отношения";
}

function crestText(state: IslandView) {
  return stateMarkText(displayName(state), state.emblem);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawShield(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, label: string, avatar?: HTMLImageElement) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -size * .52);
  ctx.lineTo(size * .44, -size * .35);
  ctx.lineTo(size * .38, size * .28);
  ctx.quadraticCurveTo(0, size * .56, -size * .38, size * .28);
  ctx.lineTo(-size * .44, -size * .35);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  g.addColorStop(0, "#f5df9d");
  g.addColorStop(.08, color);
  g.addColorStop(.88, color);
  g.addColorStop(1, "#332719");
  ctx.fillStyle = g;
  ctx.shadowColor = "rgba(0,0,0,.4)";
  ctx.shadowBlur = size * .16;
  ctx.shadowOffsetY = size * .08;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(1, size * .035);
  ctx.strokeStyle = "rgba(248,225,164,.9)";
  ctx.stroke();
  if (avatar && avatar.complete && avatar.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, size * .27, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, -size * .27, -size * .27, size * .54, size * .54);
    ctx.restore();
  } else {
    ctx.fillStyle = "#fff4d6";
    ctx.font = `900 ${Math.max(9, size * .23)}px Georgia, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 2).toUpperCase(), 0, 1);
  }
  ctx.restore();
}

/**
 * Canvas map renderer.
 *
 * The previous implementation moved a giant DOM/SVG tree with CSS scale transforms.
 * At high zoom that forced the browser to rasterize very large layers and caused
 * flashing/disappearing castles while panning. This renderer keeps the map itself in
 * one small canvas and only repaints the visible pixels on requestAnimationFrame.
 */
function IslandMapInner({ snapshot, selected, onSelect, onAttack, onSwitchState, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const terrainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const terrainKeyRef = useRef<string>("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ width: 390, height: 620, dpr: 1 });
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: DEFAULT_ZOOM });
  const rafRef = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ id: number; x: number; y: number; camera: Camera; moved: boolean } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const interactionTimer = useRef<number | null>(null);
  const exploreTimer = useRef<number | null>(null);
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const [size, setSize] = useState({ width: 390, height: 620 });
  const [camera, setCamera] = useState<Camera>(() => cameraRef.current);
  const [filter, setFilter] = useState<MapFilter>("all");
  const [query, setQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [warType, setWarType] = useState<WarType>("raid");
  const [now, setNow] = useState(() => Date.now());

  const bounds = useMemo(() => {
    if (!snapshot.islands.length) return { minX: -3000, maxX: 3000, minY: -3000, maxY: 3000 };
    return snapshot.islands.reduce((acc, state) => ({
      minX: Math.min(acc.minX, state.worldX), maxX: Math.max(acc.maxX, state.worldX),
      minY: Math.min(acc.minY, state.worldY), maxY: Math.max(acc.maxY, state.worldY),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  }, [snapshot.islands]);

  const normalizedQuery = query.trim().replace(/^@/, "").toLocaleLowerCase("ru-RU");
  const searchResults = useMemo(() => normalizedQuery
    ? snapshot.islands.filter((state) => displayName(state).toLocaleLowerCase("ru-RU").includes(normalizedQuery) || (state.stateUsername || "").toLocaleLowerCase("ru-RU").includes(normalizedQuery)).slice(0, 8)
    : [], [normalizedQuery, snapshot.islands]);
  const visibleStates = useMemo(() => snapshot.islands.filter((state) => state.isMine || selected?.id === state.id || filter === "all" || (filter === "enemy" && state.relation === "war") || (filter === "ally" && state.relation === "allied") || (filter === "neutral" && !state.relation)), [filter, selected?.id, snapshot.islands]);
  const allied = useMemo(() => snapshot.islands.filter((state) => state.relation === "allied" && !state.isMine), [snapshot.islands]);
  const mine = useMemo(() => snapshot.islands.find((state) => state.isMine) || null, [snapshot.islands]);
  const selectedReason = selected ? attackReason(snapshot, selected, now) : null;
  const activeBattle = snapshot.activeBattle && snapshot.activeBattle.status !== "resolved" && new Date(snapshot.activeBattle.endsAt).getTime() > now ? snapshot.activeBattle : null;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height, dpr } = sizeRef.current;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const cam = cameraRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Static-looking strategic terrain, generated directly into the current viewport.
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#5e873b");
    bg.addColorStop(.55, "#4f7932");
    bg.addColorStop(1, "#3f6129");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const worldToScreen = (x: number, y: number) => ({ x: width / 2 + (x - cam.x) * cam.zoom, y: height / 2 + (y - cam.y) * cam.zoom });
    const center = worldToScreen(0, 0);
    const continentRadius = Math.max(width, height) * .72;
    const terrain = ctx.createRadialGradient(center.x - continentRadius * .2, center.y - continentRadius * .22, 20, center.x, center.y, continentRadius);
    terrain.addColorStop(0, "rgba(130,165,76,.34)");
    terrain.addColorStop(.55, "rgba(84,126,45,.12)");
    terrain.addColorStop(1, "rgba(24,39,18,.24)");
    ctx.fillStyle = terrain;
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, continentRadius, continentRadius * .82, -.12, 0, Math.PI * 2);
    ctx.fill();

    // Cheap terrain texture: cached into offscreen terrain canvas.
    if (needTerrainRepaint && terrainCanvasRef.current) {
      const tc = terrainCanvasRef.current.getContext("2d", { alpha: false })!;
      tc.setTransform(dpr, 0, 0, dpr, 0, 0);
      tc.save();
      tc.globalAlpha = .18;
      for (let i = 0; i < 24; i++) {
        const wx = -5000 + ((i * 1379) % 10000);
        const wy = -4200 + ((i * 977) % 8400);
        const p = worldToScreen(wx, wy);
        const r = (180 + (i % 5) * 70) * cam.zoom;
        tc.fillStyle = i % 3 === 0 ? "#263e20" : i % 3 === 1 ? "#9aa45d" : "#6c8f42";
        tc.beginPath();
        tc.ellipse(p.x, p.y, r * 1.5, r * .7, i * .31, 0, Math.PI * 2);
        tc.fill();
      }
      tc.restore();
    }

    // Strategic roads become thinner and disappear when zoomed out.
    if (cam.zoom > .28) {
      ctx.save();
      ctx.globalAlpha = .22;
      ctx.lineWidth = Math.max(1, 5 * cam.zoom);
      ctx.strokeStyle = "#d5bd7b";
      const roads: Array<[number, number, number, number]> = [[-4300,-2200,3800,1600],[-3100,2500,4200,-1200],[-900,-4200,1200,3900]];
      for (const [x1,y1,x2,y2] of roads) {
        const a = worldToScreen(x1,y1), b = worldToScreen(x2,y2);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      ctx.restore();
    }

    // Alliance lines are tiny compared with the old 10,000x10,000 SVG and are only drawn when useful.
    if (cam.zoom >= .32 && mine) {
      ctx.save();
      ctx.strokeStyle = "rgba(239,209,128,.62)";
      ctx.lineWidth = Math.max(1, 4 * cam.zoom);
      ctx.setLineDash([10 * cam.zoom, 9 * cam.zoom]);
      for (const ally of allied) {
        const a = worldToScreen(mine.worldX, mine.worldY), b = worldToScreen(ally.worldX, ally.worldY);
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      ctx.restore();
    }

    const far = cam.zoom < .52;
    const mid = cam.zoom < 1.02;
    const near = !far && !mid;
    for (const state of visibleStates) {
      const p = worldToScreen(state.worldX, state.worldY);
      const markerPx = cam.zoom < 0.30 ? 100 : cam.zoom < 0.52 ? 100 + (cam.zoom - 0.30) * 60 : cam.zoom < 1.02 ? 112 - (cam.zoom - 0.52) * 40 : 100 + (cam.zoom - 1.02) * 21;
      const half = markerPx / 2;
      if (p.x < -half - 40 || p.x > width + half + 40 || p.y < -half - 70 || p.y > height + half + 100) continue;
      const ruined = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > Date.now());
      const selectedHere = selected?.id === state.id;
      const relation = state.relation;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = ruined ? .55 : 1;
      ctx.shadowColor = selectedHere || state.isMine ? "rgba(244,205,105,.72)" : "rgba(0,0,0,.42)";
      ctx.shadowBlur = selectedHere || state.isMine ? 16 : 9;
      ctx.shadowOffsetY = 8;

      // Ground plate: reads as a settlement instead of a flat 2D icon.
      ctx.fillStyle = relation === "war" ? "rgba(116,48,35,.55)" : relation === "allied" ? "rgba(76,120,52,.58)" : "rgba(38,51,29,.55)";
      ctx.beginPath();
      ctx.ellipse(0, markerPx * .28, markerPx * .44, markerPx * .13, 0, 0, Math.PI * 2);
      ctx.fill();

      // Territory glow ring - gives each settlement a sense of owned land.
      if (cam.zoom > 0.38) {
        const glowAlpha = Math.min(0.18, (cam.zoom - 0.38) * 0.5);
        const glowR = markerPx * 0.72;
        const territoryGrad = ctx.createRadialGradient(0, 0, markerPx * 0.15, 0, 0, glowR);
        territoryGrad.addColorStop(0, (state.color || "#7d6342") + "44");
        territoryGrad.addColorStop(0.6, (state.color || "#7d6342") + "18");
        territoryGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save();
        ctx.globalAlpha = glowAlpha;
        ctx.fillStyle = territoryGrad;
        ctx.beginPath(); ctx.ellipse(0, markerPx * 0.08, glowR, glowR * 0.55, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      const s = markerPx;
      // Isometric-ish castle body with bevels and three towers.
      const bodyTop = -s * .10;
      const bodyBottom = s * .32;
      const towerW = s * .16;
      const towerH = s * .43;
      const towerY = bodyBottom - towerH;
      const stone = ctx.createLinearGradient(0, towerY, 0, bodyBottom);
      stone.addColorStop(0, "#eee5cb"); stone.addColorStop(.35, "#bcb39e"); stone.addColorStop(.72, "#817a6b"); stone.addColorStop(1, "#504b42");
      ctx.fillStyle = stone;
      roundRect(ctx, -s*.31, bodyTop, s*.62, s*.40, s*.025); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.fillRect(-s*.30, bodyTop + 2, s*.60, s*.035);

      for (const tx of [-s*.34, s*.18]) {
        ctx.fillStyle = stone;
        roundRect(ctx, tx, towerY, towerW, towerH, s*.018); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,.2)";
        ctx.fillRect(tx + 2, towerY + 2, towerW*.16, towerH - 4);
        // crenellations
        ctx.fillStyle = "#d6cdb7";
        const blocks = 3;
        for (let b = 0; b < blocks; b++) ctx.fillRect(tx + b * towerW/3, towerY - s*.065, towerW*.22, s*.065);
      }
      // central keep
      ctx.fillStyle = stone;
      roundRect(ctx, -s*.13, -s*.26, s*.26, s*.48, s*.018); ctx.fill();
      ctx.fillStyle = "#d7cdb5";
      for (let b = 0; b < 3; b++) ctx.fillRect(-s*.13 + b*s*.09, -s*.33, s*.052, s*.07);
      // gate and windows
      ctx.fillStyle = "#34271d";
      ctx.beginPath(); ctx.arc(0, bodyBottom - s*.07, s*.065, Math.PI, 0); ctx.lineTo(s*.065, bodyBottom); ctx.lineTo(-s*.065, bodyBottom); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#4b4034";
      for (const wx of [-s*.25,s*.25]) { ctx.fillRect(wx, towerY + towerH*.35, s*.055, s*.09); }
      // flags
      ctx.strokeStyle = "#4a3928"; ctx.lineWidth = Math.max(1, s*.018);
      ctx.beginPath(); ctx.moveTo(-s*.27, towerY-s*.03); ctx.lineTo(-s*.27, towerY-s*.25); ctx.moveTo(s*.27, towerY-s*.03); ctx.lineTo(s*.27, towerY-s*.25); ctx.stroke();
      ctx.fillStyle = state.color || "#8d6840";
      ctx.beginPath(); ctx.moveTo(-s*.27,towerY-s*.24); ctx.lineTo(-s*.09,towerY-s*.20); ctx.lineTo(-s*.27,towerY-s*.15); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s*.27,towerY-s*.24); ctx.lineTo(s*.09,towerY-s*.20); ctx.lineTo(s*.27,towerY-s*.15); ctx.closePath(); ctx.fill();
      ctx.restore();

      // Shield is separate from the building, making the settlement recognizable even at full-world view.
      const avatarUrl = state.avatarUrl;
      let avatar: HTMLImageElement | undefined;
      if (avatarUrl) {
        avatar = imageCache.current.get(avatarUrl);
        if (!avatar) {
          const img = new window.Image();
          img.crossOrigin = "anonymous";
          img.onload = () => requestDraw();
          img.src = avatarUrl;
          imageCache.current.set(avatarUrl, img);
        }
      }
      drawShield(ctx, p.x, p.y - markerPx*.34, markerPx*.27, state.color || "#7d6342", crestText(state), avatar);

      if (selectedHere) {
        ctx.save(); ctx.strokeStyle = "#f2cf75"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x,p.y,markerPx*.56,0,Math.PI*2); ctx.stroke(); ctx.restore();
      }

      // Smooth label fade: alpha ramps from 0 at zoom 0.28 to 1 at zoom 0.62.
      const labelAlpha = cam.zoom < 0.28 ? 0 : cam.zoom < 0.62 ? (cam.zoom - 0.28) / 0.34 : 1;
      if (labelAlpha > 0.01) {
        const labelY = p.y + markerPx * .62;
        ctx.save();
        ctx.globalAlpha *= labelAlpha;
        const fontSize = cam.zoom < 0.62 ? 11 : cam.zoom < 1.02 ? 12 : 14;
        ctx.font = `800 ${fontSize}px Georgia, serif`;
        const title = displayName(state);
        const textW = Math.min(220, Math.max(90, ctx.measureText(title).width + 22));
        ctx.fillStyle = "rgba(25,22,16,.94)";
        roundRect(ctx, p.x - textW/2, labelY, textW, fontSize < 13 ? 23 : 29, 8); ctx.fill();
        ctx.fillStyle = "#f4e8c9"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(title, p.x, labelY + (fontSize < 13 ? 11 : 14));
        ctx.restore();
      }
    }
  }, [allied, mine, selected, visibleStates]);

  const requestDraw = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const el = viewportRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const update = () => {
      const width = el.clientWidth || 390;
      const height = el.clientHeight || 620;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // Intentionally NOT calling setSize to avoid per-resize React re-renders.
      // Canvas is repainted via requestDraw; DOM layout is CSS-driven.
      requestDraw();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [requestDraw, snapshot.islands, selected, filter]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem("warstate-map-camera-v6");
      if (stored) {
        const parsed = JSON.parse(stored) as Camera;
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.zoom)) {
          cameraRef.current = { x: parsed.x, y: parsed.y, zoom: clamp(parsed.zoom, MIN_ZOOM, MAX_ZOOM) };
          setCamera(cameraRef.current);
        }
      }
    } catch { /* optional */ }
    requestDraw();
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      if (interactionTimer.current != null) window.clearTimeout(interactionTimer.current);
      if (exploreTimer.current != null) window.clearTimeout(exploreTimer.current);
    };
  }, [requestDraw]);

  const prevLodRef = useRef<string>("mid");
  const commitCamera = useCallback((next: Camera, explore = true) => {
    cameraRef.current = next;
    // Only trigger React re-render when LOD tier changes - avoids per-frame renders.
    const lod = next.zoom < 0.52 ? "far" : next.zoom < 1.02 ? "mid" : "near";
    if (lod !== prevLodRef.current) {
      prevLodRef.current = lod;
      setCamera(next);
    }
    try { window.sessionStorage.setItem("warstate-map-camera-v6", JSON.stringify(next)); } catch { /* optional */ }
    requestDraw();
    if (explore && onExplore) {
      if (exploreTimer.current != null) window.clearTimeout(exploreTimer.current);
      exploreTimer.current = window.setTimeout(() => onExplore(next.x, next.y, Math.min(9000, Math.max(2400, 3200 / next.zoom))), 180);
    }
  }, [onExplore, requestDraw]);

  const localPoint = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const zoomAt = useCallback((nextZoom: number, screenX = sizeRef.current.width / 2, screenY = sizeRef.current.height / 2, commit = true) => {
    const current = cameraRef.current;
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const worldX = current.x + (screenX - sizeRef.current.width / 2) / current.zoom;
    const worldY = current.y + (screenY - sizeRef.current.height / 2) / current.zoom;
    const next = { x: worldX - (screenX - sizeRef.current.width / 2) / zoom, y: worldY - (screenY - sizeRef.current.height / 2) / zoom, zoom };
    cameraRef.current = next;
    requestDraw();
    if (commit) commitCamera(next, false);
    else {
      if (interactionTimer.current != null) window.clearTimeout(interactionTimer.current);
      interactionTimer.current = window.setTimeout(() => commitCamera(cameraRef.current, false), 100);
    }
  }, [commitCamera, requestDraw]);

  const findStateAt = useCallback((screenX: number, screenY: number) => {
    const cam = cameraRef.current;
    let best: IslandView | null = null;
    let bestDist = Infinity;
    const maxPx = cam.zoom < .52 ? 62 : 70;
    for (const state of visibleStates) {
      const dx = (state.worldX - cam.x) * cam.zoom + sizeRef.current.width / 2 - screenX;
      const dy = (state.worldY - cam.y) * cam.zoom + sizeRef.current.height / 2 - screenY;
      const d = Math.hypot(dx, dy);
      if (d < maxPx && d < bestDist) { best = state; bestDist = d; }
    }
    return best;
  }, [visibleStates]);

  const pointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, aside")) return;
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) dragRef.current = { id: event.pointerId, x: point.x, y: point.y, camera: { ...cameraRef.current }, moved: false };
    if (pointers.current.size === 2) {
      const [a,b] = [...pointers.current.values()];
      const midX = (a.x+b.x)/2, midY = (a.y+b.y)/2;
      const c = cameraRef.current;
      pinchRef.current = { distance: Math.max(1, Math.hypot(a.x-b.x,a.y-b.y)), zoom: c.zoom, worldX: c.x + (midX-sizeRef.current.width/2)/c.zoom, worldY: c.y + (midY-sizeRef.current.height/2)/c.zoom };
      dragRef.current = null;
    }
  }, [localPoint]);

  const pointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size >= 2 && pinchRef.current) {
      const [a,b] = [...pointers.current.values()];
      const midX=(a.x+b.x)/2, midY=(a.y+b.y)/2;
      const distance=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y));
      const pinch=pinchRef.current;
      const zoom=clamp(pinch.zoom*distance/pinch.distance,MIN_ZOOM,MAX_ZOOM);
      const next={x:pinch.worldX-(midX-sizeRef.current.width/2)/zoom,y:pinch.worldY-(midY-sizeRef.current.height/2)/zoom,zoom};
      cameraRef.current=next; requestDraw();
      return;
    }
    const drag=dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (Math.hypot(point.x-drag.x,point.y-drag.y)>5) drag.moved=true;
    const next={...drag.camera,x:drag.camera.x-(point.x-drag.x)/drag.camera.zoom,y:drag.camera.y-(point.y-drag.y)/drag.camera.zoom};
    cameraRef.current=next; requestDraw();
  }, [localPoint, requestDraw]);

  const pointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointers.current.get(event.pointerId);
    const drag = dragRef.current;
    pointers.current.delete(event.pointerId);
    pinchRef.current = null;
    if (pointers.current.size === 1) {
      const [id,p] = [...pointers.current.entries()][0];
      dragRef.current={id,x:p.x,y:p.y,camera:{...cameraRef.current},moved:false};
    } else {
      dragRef.current=null;
      commitCamera(cameraRef.current,false);
    }
    if (point && drag && !drag.moved && pointers.current.size===0) {
      const state=findStateAt(point.x,point.y);
      if (state) onSelect(state); else onSelect(null);
    }
  }, [commitCamera, findStateAt, onSelect]);

  const wheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect=event.currentTarget.getBoundingClientRect();
    const x=event.clientX-rect.left,y=event.clientY-rect.top;
    const factor=Math.exp(-event.deltaY*0.0015);
    zoomAt(cameraRef.current.zoom*factor,x,y,false);
  }, [zoomAt]);

  const fitWorld = useCallback(() => {
    const spanX=Math.max(900,bounds.maxX-bounds.minX+900), spanY=Math.max(900,bounds.maxY-bounds.minY+900);
    commitCamera({x:(bounds.minX+bounds.maxX)/2,y:(bounds.minY+bounds.maxY)/2,zoom:clamp(Math.min(.7,Math.min(sizeRef.current.width/spanX,sizeRef.current.height/spanY)),MIN_ZOOM,.7)});
  }, [bounds, commitCamera]);
  const centerMine = useCallback(() => commitCamera({x:snapshot.state.worldX,y:snapshot.state.worldY,zoom:.92}), [commitCamera,snapshot.state.worldX,snapshot.state.worldY]);
  const focusState = useCallback((state: IslandView) => { commitCamera({x:state.worldX,y:state.worldY,zoom:Math.max(.88,cameraRef.current.zoom)}); onSelect(state); setPanelOpen(false); }, [commitCamera,onSelect]);

  // Keep the state around for controls/LOD labels without driving the renderer on every pointer event.
  const detail: "far" | "mid" | "near" = cameraRef.current.zoom < .52 ? "far" : cameraRef.current.zoom < 1.02 ? "mid" : "near";

  return (
    <div className="continent-map-screen">
      {activeBattle && <button type="button" className="continent-war-alert" onClick={onOpenBattle}><span>⚔</span><div><small>АКТИВНЫЙ БОЙ</small><b>{activeBattle.attackerName} · {activeBattle.defenderName}</b></div><em>{timeLeft(activeBattle.endsAt, now)}</em></button>}
      <div ref={viewportRef} className={`continent-viewport lod-${detail}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel}>
        <canvas ref={canvasRef} className="continent-map-canvas" aria-label="Стратегическая карта государств" />
        <div className="continent-map-head" onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>e.stopPropagation()}><div><small>МИРОВАЯ КАРТА</small><b>Материк государств</b></div><span className="lod-badge">LOD {detail === "far" ? "1" : detail === "mid" ? "2" : "3"}</span></div>
        <div className="continent-map-tools left" onClick={(e)=>e.stopPropagation()}><button type="button" onClick={centerMine} aria-label="Моё государство">⌂</button><button type="button" onClick={()=>setPanelOpen(v=>!v)} aria-label="Поиск и фильтры">⌕</button><button type="button" onClick={fitWorld} aria-label="Показать весь материк">▣</button></div>
        <div className="continent-map-tools right" onClick={(e)=>e.stopPropagation()}><button type="button" onClick={()=>zoomAt(cameraRef.current.zoom+.16)}>＋</button><button type="button" onClick={()=>zoomAt(cameraRef.current.zoom-.16)}>−</button></div>
        {panelOpen && <aside className="continent-radar" onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>e.stopPropagation()}>
          <div className="continent-radar-head"><div><small>НАВИГАЦИЯ</small><b>Государства</b></div><button type="button" onClick={()=>setPanelOpen(false)}>×</button></div>
          <label className="continent-search"><span>⌕</span><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Название или @юз" /></label>
          <div className="continent-filters">{([['all','Все'],['enemy','Противники'],['ally','Союзники'],['neutral','Нейтральные']] as Array<[MapFilter,string]>).map(([key,label])=><button type="button" key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{label}</button>)}</div>
          {normalizedQuery && <div className="continent-search-results">{searchResults.length ? searchResults.map((state)=><button type="button" key={state.id} onClick={()=>focusState(state)}><i style={{background:state.color}}>{crestText(state)}</i><span><b>{displayName(state)}</b><small>{state.memberCount.toLocaleString("ru-RU")} жителей · {state.rating} ELO · {state.allianceCount} союзов</small></span></button>) : <p>Ничего не найдено</p>}</div>}
          <div className="continent-map-key"><span><i className="ally"/>Союз</span><span><i className="enemy"/>Война</span><span><i className="mine"/>Ваше государство</span></div>
        </aside>}
      </div>

      {selected && <section className="state-inspector" style={{"--state-color":selected.color} as CSSProperties}>
        <button type="button" className="state-inspector-close" onClick={()=>onSelect(null)} aria-label="Закрыть">×</button>
        <div className="state-inspector-title"><span style={{background:selected.color}}>{selected.avatarUrl ? <Image src={selected.avatarUrl} alt="" width={64} height={64} unoptimized /> : crestText(selected)}</span><div><small>{relationText(selected)}</small><h3>{displayName(selected)}</h3>{selected.stateUsername && <em>@{selected.stateUsername}</em>}<p>{selected.presidentName ? `Правитель: ${selected.presidentName}` : "Правитель ещё не назначен"}</p></div></div>
        <div className="state-inspector-grid"><span><b>{selected.memberCount.toLocaleString("ru-RU")}</b><small>население</small></span><span><b>{selected.armyPower.toLocaleString("ru-RU")}</b><small>армия</small></span><span><b>{selected.treasuryCredits.toLocaleString("ru-RU")}</b><small>казна</small></span><span><b>{selected.allianceCount}</b><small>союзы</small></span><span><b>{selected.integrity}%</b><small>прочность</small></span><span><b>{selected.rating}</b><small>ELO</small></span></div>
        <div className="state-inspector-meta"><span>Активный гарнизон: <b>{selected.activePlayers}</b></span><span>Баланс побед: <b>{selected.wins}:{selected.losses}</b></span><span>Серия: <b>x{selected.winStreak}</b></span></div>
        {!selected.isMine && !selected.isFreeport && <button type="button" className="state-switch" onClick={()=>onSwitchState(selected)}>Перейти в государство<small>Бот проверит членство в Telegram-чате</small></button>}
        {selected.isMine ? <button type="button" className="state-primary" onClick={onOpenIsland}>Открыть замок<small>Казна, армия, инфраструктура</small></button> : selected.isFreeport || selected.isBeginnerIsland ? <div className="state-protected">Эта территория защищена и не участвует в атаках.</div> : <div className="state-war-actions"><div>{(["raid","siege","territory"] as WarType[]).map((type)=><button type="button" key={type} className={warType===type?"active":""} onClick={()=>setWarType(type)} disabled={Boolean(selectedReason)}>{type==="raid"?"Рейд":type==="siege"?"Осада":"Территория"}</button>)}</div><button type="button" className="state-primary danger" disabled={Boolean(selectedReason)} onClick={()=>onAttack(selected,warType)}>Запустить голосование<small>{selectedReason || "Решение принимают граждане государства"}</small></button></div>}
      </section>}
    </div>
  );
}

export const IslandMap = memo(IslandMapInner);
