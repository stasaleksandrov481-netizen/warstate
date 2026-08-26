"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { eloDeltaPreview, eloLeague } from "@/lib/elo";
import type { GameSnapshot, IslandView, WarType } from "@/lib/types";
import { IslandArt } from "@/components/game/island-art";
import { OceanCanvas } from "@/components/game/ocean-canvas";

function islandSize(members: number, freeport = false) {
  if (freeport) return 720;
  // Population still matters visually, but the hard cap prevents a very large
  // Telegram group from becoming a continent that hides all nearby states.
  const population = Math.max(1, members);
  return Math.max(180, Math.min(820, 150 + Math.pow(population, 0.46) * 21));
}

function timeLeft(iso?: string | null, now = Date.now()) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.max(1, Math.floor((ms % 3_600_000) / 60_000));
  return hours ? `${hours}ч ${minutes}м` : `${minutes}м`;
}

function attackReason(snapshot: GameSnapshot, island: IslandView, now: number) {
  if (island.isMine) return "Это ваш остров";
  if (snapshot.state.isFreeport) return "Свободные игроки Freeport не участвуют в войнах";
  if (snapshot.state.isBeginnerIsland) return "С Острова новичков нельзя начинать войны";
  if (island.isFreeport) return "Freeport — нейтральная территория";
  if (island.isBeginnerIsland) return "Остров новичков находится под защитой";
  if (snapshot.player.role !== "president") return "Голосование о войне запускает только Президент";
  if (snapshot.activeBattle) return "Ваш флот уже участвует в битве";
  if (snapshot.state.destroyedUntil && new Date(snapshot.state.destroyedUntil).getTime() > now) return "Ваш остров восстанавливается";
  if (island.destroyedUntil && new Date(island.destroyedUntil).getTime() > now) return "Остров уже в руинах";
  if (island.shieldUntil && new Date(island.shieldUntil).getTime() > now) return "Защитный щит активен";
  if (island.relation === "allied") return "Союзный остров";
  if (island.relation === "truce") return "Действует перемирие";
  if (snapshot.state.nextAttackAt && new Date(snapshot.state.nextAttackAt).getTime() > now) return `Флот готовится · ${timeLeft(snapshot.state.nextAttackAt, now) || "скоро"}`;
  if (snapshot.state.treasury.fuel < 120 || snapshot.state.treasury.food < 80) return "Нужно 120 топлива и 80 еды";
  return null;
}


function CloseIcon() {
  return <span className="ui-close-icon" aria-hidden="true" />;
}

type Camera = { x: number; y: number; zoom: number };
type MapFilter = "all" | "enemy" | "ally" | "neutral";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 1.55;
const DEFAULT_STATE_ZOOM = 0.58;
const DEFAULT_FREEPORT_ZOOM = 0.50;
const CAMERA_STORAGE_VERSION = "v3";

function cameraTransform(camera: Camera, viewport: { width: number; height: number }) {
  const tx = viewport.width / 2 - camera.x * camera.zoom;
  const ty = viewport.height / 2 - camera.y * camera.zoom;
  return `translate3d(${tx}px, ${ty}px, 0) scale(${camera.zoom})`;
}

type PointerPoint = { x: number; y: number };

type Props = {
  snapshot: GameSnapshot;
  selected: IslandView | null;
  onSelect: (island: IslandView | null) => void;
  onAttack: (island: IslandView, battleType: WarType) => void;
  onSwitchState: (island: IslandView) => void;
  onExplore?: (x: number, y: number, radius: number) => void;
  onOpenBattle?: () => void;
  onOpenIsland?: () => void;
};

const COMPACT_NUMBER = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

const IslandNode = memo(function IslandNode({
  island,
  selectedId,
  detail,
  now,
  onSelect: handleSelect,
  zoom,
}: {
  island: IslandView;
  selectedId: string | null;
  detail: "far" | "mid" | "near";
  now: number;
  onSelect: (island: IslandView) => void;
  zoom: number;
}) {
  const size = islandSize(island.memberCount, island.isFreeport);
  const ruined = Boolean(island.destroyedUntil && new Date(island.destroyedUntil).getTime() > now);
  const selected = selectedId === island.id;
  const league = eloLeague(island.rating);
  const relationLabel = island.isBeginnerIsland ? "НОВИЧКИ" : island.isFreeport ? "НЕЙТРАЛЬНО" : island.relation === "war" ? "ВРАГ" : island.relation === "allied" ? "СОЮЗ" : island.relation === "truce" ? "МИР" : null;

  // LOD: compute inverse scale factor to counteract zoom and keep label readable
  // At min zoom (0.05) labels would be 20x smaller; we clamp to a readable size
  const labelScale = Math.max(0.55, Math.min(1.35, 1 / Math.pow(zoom, 0.38)));
  const labelFontSize = Math.max(7.5, Math.min(13.5, 10 * labelScale));
  const kickerFontSize = Math.max(5.5, Math.min(9, 7 * labelScale));
  const smallFontSize = Math.max(5, Math.min(8.5, 6.5 * labelScale));
  const avatarSize = Math.max(22, Math.min(48, 36 * labelScale));
  const padH = Math.max(4, Math.min(12, 8 * labelScale));
  const padV = Math.max(3, Math.min(8, 5.5 * labelScale));
  const gap = Math.max(1, Math.min(4, 2.5 * labelScale));

  // far: compact badge; mid: medium card; near: full card
  const showFar = detail === "far";
  const showMid = detail === "mid";
  const showNear = detail === "near";

  return (
    <button
      type="button"
      className={`game-island-node ${island.isFreeport ? "freeport" : ""} ${island.isMine ? "mine" : ""} ${ruined ? "ruined" : ""} ${selected ? "selected" : ""} ${island.relation ? `relation-${island.relation}` : ""} lod-${detail}`}
      style={{ left: island.worldX, top: island.worldY, width: size, height: size * 0.69, ["--island-color" as string]: island.color, ["--label-scale" as string]: String(labelScale), ["--label-font" as string]: `${labelFontSize}px`, ["--kicker-font" as string]: `${kickerFontSize}px`, ["--small-font" as string]: `${smallFontSize}px`, ["--avatar-size" as string]: `${avatarSize}px`, ["--pad-h" as string]: `${padH}px`, ["--pad-v" as string]: `${padV}px`, ["--label-gap" as string]: `${gap}px` }}
      onClick={(event) => { event.stopPropagation(); handleSelect(island); }}
      aria-label={`${island.name}, ${island.memberCount} участников, рейтинг ${island.rating}`}
    >
      <IslandArt id={island.id} members={island.memberCount} color={island.color} integrity={island.integrity} ruined={ruined} selected={selected} detail={detail} freeport={island.isFreeport} />

      {/* LOD far: minimal badge — icon + name only */}
      {showFar && !selected && (
        <span className="game-island-label lod-badge" style={{ transform: "translate(-50%,-100%)" }}>
          <span className="lod-badge-icon" style={{ background: island.color, width: avatarSize, height: avatarSize, borderRadius: Math.max(4, avatarSize * 0.26) }}>
            {island.avatarUrl ? <Image src={island.avatarUrl} alt="" width={Math.round(avatarSize)} height={Math.round(avatarSize)} unoptimized draggable={false} /> : <b style={{ fontSize: Math.max(8, avatarSize * 0.48) }}>{island.emblem || island.name.slice(0, 1)}</b>}
          </span>
          {!island.isFreeport && <strong className="lod-badge-name" style={{ fontSize: labelFontSize }}>{island.name}</strong>}
        </span>
      )}

      {/* LOD mid: medium card — name, key stats, president */}
      {showMid && !selected && (
        <span className="game-island-label lod-mid-card" style={{ transform: "translate(-50%,-100%)" }}>
          <span className="game-island-avatar" style={{ background: island.color, width: avatarSize, height: avatarSize, borderRadius: Math.max(4, avatarSize * 0.26) }}>
            {island.avatarUrl ? <Image src={island.avatarUrl} alt="" width={Math.round(avatarSize)} height={Math.round(avatarSize)} unoptimized draggable={false} /> : <b style={{ fontSize: Math.max(8, avatarSize * 0.48) }}>{island.emblem || island.name.slice(0, 1)}</b>}
          </span>
          <span className="game-island-copy" style={{ fontSize: labelFontSize }}>
            <span className="game-island-kicker" style={{ fontSize: kickerFontSize }}>
              <em>{island.isMine ? "МОЙ ОСТРОВ" : island.isBeginnerIsland ? "ОСТРОВ НОВИЧКОВ" : island.isFreeport ? "FREEPORT" : league.label.toUpperCase()}</em>
              {island.rank > 0 && <b>#{island.rank}</b>}
            </span>
            <strong>{island.name}</strong>
            <small style={{ fontSize: smallFontSize }}>
              <span>👥 {COMPACT_NUMBER.format(island.memberCount)}</span>
              <span>{league.icon} {island.rating}</span>
              <span>⚔ {island.armyPower}</span>
            </small>
            {island.presidentName && <em className="lod-president" style={{ fontSize: smallFontSize }}>👑 {island.presidentName}</em>}
          </span>
          {relationLabel && <em className={`relation-tag ${island.isBeginnerIsland ? "tag-beginner" : `tag-${island.relation}`}`}>{relationLabel}</em>}
          <i className={`game-status ${island.isFreeport ? "freeport" : ruined ? "ruins" : island.relation === "war" ? "enemy" : island.relation === "allied" ? "ally" : "neutral"}`} />
        </span>
      )}

      {/* LOD near (or selected at any level): full card with all info */}
      {(showNear || selected) && (
        <span className="game-island-label lod-full-card" style={{ transform: "translate(-50%,-100%)" }}>
          <span className="game-island-avatar" style={{ background: island.color }}>
            {island.avatarUrl ? <Image src={island.avatarUrl} alt="" width={42} height={42} unoptimized draggable={false} /> : <b>{island.emblem || island.name.slice(0, 1)}</b>}
          </span>
          <span className="game-island-copy">
            <span className="game-island-kicker">
              <em>{island.isMine ? "МОЙ ОСТРОВ" : island.isBeginnerIsland ? "ОСТРОВ НОВИЧКОВ" : island.isFreeport ? "FREEPORT" : league.label.toUpperCase()}</em>
              {island.rank > 0 && <b>#{island.rank}</b>}
            </span>
            <strong>{island.name}</strong>{island.stateUsername && <em className="game-island-handle">@{island.stateUsername}</em>}
            <small><span>👥 {COMPACT_NUMBER.format(island.memberCount)}</span><span>{league.icon} {island.rating} ELO</span></small>
            {island.presidentName && <em className="lod-president">👑 {island.presidentName}</em>}
            <small className="lod-stats-row"><span>⚔ {island.armyPower}</span><span>🛡 {island.defensePower}</span>{island.allianceCount > 0 && <span>🤝 {island.allianceCount}</span>}<span>🏆 {island.wins}/{island.losses}</span></small>
          </span>
          {relationLabel && <em className={`relation-tag ${island.isBeginnerIsland ? "tag-beginner" : `tag-${island.relation}`}`}>{relationLabel}</em>}
          <i className={`game-status ${island.isFreeport ? "freeport" : ruined ? "ruins" : island.relation === "war" ? "enemy" : island.relation === "allied" ? "ally" : "neutral"}`} />
        </span>
      )}

      {island.integrity < 100 && !ruined && <span className="game-integrity"><i style={{ width: `${island.integrity}%` }} /></span>}
      {ruined && <span className="game-ruins-timer">РУИНЫ · {timeLeft(island.destroyedUntil, now) || "восстановление"}</span>}
    </button>
  );
});

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onSwitchState, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldLayerRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const viewportRectRef = useRef<DOMRect | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const exploreKickRef = useRef<number | null>(null);
  const cameraRafRef = useRef<number | null>(null);
  const pendingCameraRef = useRef<Camera | null>(null);
  const cameraCommitTimerRef = useRef<number | null>(null);
  const lastCameraCommitRef = useRef(0);
  const interactingRef = useRef(false);
  const viewportSizeRef = useRef({ width: 390, height: 620 });
  const movedRef = useRef(false);
  const velocityRef = useRef({ x: 0, y: 0, at: 0 });
  const inertiaRafRef = useRef<number | null>(null);
  const cameraTweenRafRef = useRef<number | null>(null);
  // Zoomed further out by default so the nearest neighbouring islands are
  // visible on open instead of requiring a long pan/scroll to reach them.
  const defaultZoom = snapshot.state.isFreeport ? DEFAULT_FREEPORT_ZOOM : DEFAULT_STATE_ZOOM;
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: defaultZoom });
  const [camera, setCamera] = useState<Camera>(cameraRef.current);
  const [viewport, setViewport] = useState({ width: 390, height: 620 });
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [warType, setWarType] = useState<WarType>("raid");
  const [radarOpen, setRadarOpen] = useState(false);
  const [mapFilter, setMapFilter] = useState<MapFilter>("all");
  const [query, setQuery] = useState("");
  const [sheetClosing, setSheetClosing] = useState(false);
  const sheetCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const nextViewport = { width: entry.contentRect.width, height: entry.contentRect.height };
      viewportSizeRef.current = nextViewport;
      setViewport(nextViewport);
      if (worldLayerRef.current) worldLayerRef.current.style.transform = cameraTransform(cameraRef.current, nextViewport);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`warstate:camera:${CAMERA_STORAGE_VERSION}:${snapshot.state.id}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Camera>;
      if (![saved.x, saved.y, saved.zoom].every((value) => typeof value === "number" && Number.isFinite(value))) return;
      // World coordinates were compacted in v3.6. Refuse stale/far-away camera
      // positions instead of opening on apparently empty water after an update.
      if (Math.hypot((saved.x as number) - snapshot.state.worldX, (saved.y as number) - snapshot.state.worldY) > 7200) return;
      const restored = { x: saved.x as number, y: saved.y as number, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, saved.zoom as number)) };
      cameraRef.current = restored;
      pendingCameraRef.current = restored;
      setCamera(restored);
    } catch { /* camera persistence is best-effort */ }
  }, [snapshot.state.id]);

  useEffect(() => {
    try { sessionStorage.setItem(`warstate:camera:${CAMERA_STORAGE_VERSION}:${snapshot.state.id}`, JSON.stringify(camera)); } catch { /* private mode can reject storage */ }
  }, [snapshot.state.id, camera.x, camera.y, camera.zoom]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current);
    if (cameraRafRef.current) window.cancelAnimationFrame(cameraRafRef.current);
    if (inertiaRafRef.current) window.cancelAnimationFrame(inertiaRafRef.current);
    if (cameraTweenRafRef.current) window.cancelAnimationFrame(cameraTweenRafRef.current);
    if (sheetCloseTimerRef.current) window.clearTimeout(sheetCloseTimerRef.current);
    if (cameraCommitTimerRef.current) window.clearTimeout(cameraCommitTimerRef.current);
  }, []);

  const kickExplore = useCallback((delay = 0) => {
    if (!onExplore) return;
    if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current);
    exploreKickRef.current = window.setTimeout(() => {
      const current = cameraRef.current;
      onExplore(current.x, current.y, Math.min(6500, 3000 / current.zoom));
    }, delay);
  }, [onExplore]);

  const worldBounds = useMemo(() => {
    const points = snapshot.islands;
    if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0, centerX: snapshot.state.worldX, centerY: snapshot.state.worldY };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const island of points) {
      minX = Math.min(minX, island.worldX);
      maxX = Math.max(maxX, island.worldX);
      minY = Math.min(minY, island.worldY);
      maxY = Math.max(maxY, island.worldY);
    }
    const pad = 620;
    return {
      minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad,
      centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2,
    };
  }, [snapshot.islands, snapshot.state.worldX, snapshot.state.worldY]);

  const fitWorldCamera = useCallback((): Camera => {
    const spanX = Math.max(1, worldBounds.maxX - worldBounds.minX);
    const spanY = Math.max(1, worldBounds.maxY - worldBounds.minY);
    const fitZoom = Math.min((viewport.width * 0.94) / spanX, (viewport.height * 0.82) / spanY);
    return {
      x: worldBounds.centerX,
      y: worldBounds.centerY,
      zoom: Math.max(0.018, Math.min(MAX_ZOOM, fitZoom)),
    };
  }, [viewport.height, viewport.width, worldBounds]);

  const commitCameraState = useCallback((force = false) => {
    const pending = pendingCameraRef.current || cameraRef.current;
    const nowMs = performance.now();
    const elapsed = nowMs - lastCameraCommitRef.current;
    if (force || elapsed >= 96) {
      if (cameraCommitTimerRef.current) {
        window.clearTimeout(cameraCommitTimerRef.current);
        cameraCommitTimerRef.current = null;
      }
      lastCameraCommitRef.current = nowMs;
      setCamera(pending);
      return;
    }
    if (!cameraCommitTimerRef.current) {
      cameraCommitTimerRef.current = window.setTimeout(() => {
        cameraCommitTimerRef.current = null;
        lastCameraCommitRef.current = performance.now();
        setCamera(pendingCameraRef.current || cameraRef.current);
      }, Math.max(8, 96 - elapsed));
    }
  }, []);

  const updateCamera = useCallback((next: Camera, explore = false, forceCommit = false) => {
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next.zoom));
    const normalized = clampedZoom <= MIN_ZOOM + 0.0001
      ? fitWorldCamera()
      : { ...next, zoom: clampedZoom };
    cameraRef.current = normalized;
    pendingCameraRef.current = normalized;

    // The world follows the finger imperatively at display refresh rate. React
    // state is intentionally throttled and is used only for culling/minimap/UI.
    if (!cameraRafRef.current) {
      cameraRafRef.current = window.requestAnimationFrame(() => {
        cameraRafRef.current = null;
        const pending = pendingCameraRef.current || cameraRef.current;
        if (worldLayerRef.current) worldLayerRef.current.style.transform = cameraTransform(pending, viewportSizeRef.current);
      });
    }
    commitCameraState(forceCommit);
    if (explore) kickExplore(120);
  }, [commitCameraState, fitWorldCamera, kickExplore]);

  const animateCameraTo = useCallback((target: Camera, duration = 420) => {
    if (cameraTweenRafRef.current) window.cancelAnimationFrame(cameraTweenRafRef.current);
    if (inertiaRafRef.current) { window.cancelAnimationFrame(inertiaRafRef.current); inertiaRafRef.current = null; }
    const from = { ...cameraRef.current };
    const normalized = { ...target, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target.zoom)) };
    const started = performance.now();
    interactingRef.current = true;
    const frame = (at: number) => {
      const t = Math.min(1, (at - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      updateCamera({
        x: from.x + (normalized.x - from.x) * eased,
        y: from.y + (normalized.y - from.y) * eased,
        zoom: from.zoom + (normalized.zoom - from.zoom) * eased,
      }, false, t >= 1);
      if (t < 1) cameraTweenRafRef.current = window.requestAnimationFrame(frame);
      else {
        cameraTweenRafRef.current = null;
        interactingRef.current = false;
        kickExplore(60);
      }
    };
    cameraTweenRafRef.current = window.requestAnimationFrame(frame);
  }, [kickExplore, updateCamera]);

  const zoomAt = useCallback((nextZoom: number, screenX = viewport.width / 2, screenY = viewport.height / 2, explore = true) => {
    if (inertiaRafRef.current) { window.cancelAnimationFrame(inertiaRafRef.current); inertiaRafRef.current = null; }
    if (cameraTweenRafRef.current) { window.cancelAnimationFrame(cameraTweenRafRef.current); cameraTweenRafRef.current = null; }
    interactingRef.current = false;
    const old = cameraRef.current;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    const worldX = old.x + (screenX - viewport.width / 2) / old.zoom;
    const worldY = old.y + (screenY - viewport.height / 2) / old.zoom;
    updateCamera({
      x: worldX - (screenX - viewport.width / 2) / zoom,
      y: worldY - (screenY - viewport.height / 2) / zoom,
      zoom,
    }, explore);
  }, [updateCamera, viewport.height, viewport.width]);

  const centerMine = useCallback(() => {
    animateCameraTo({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: defaultZoom });
  }, [animateCameraTo, defaultZoom, snapshot.state.worldX, snapshot.state.worldY]);

  const focusIsland = useCallback((island: IslandView) => {
    animateCameraTo({ x: island.worldX, y: island.worldY, zoom: Math.max(.70, cameraRef.current.zoom) });
    onSelect(island);
    setRadarOpen(false);
  }, [animateCameraTo, onSelect]);

  const localPoint = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = viewportRectRef.current || event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const beginPinch = useCallback(() => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const current = cameraRef.current;
    pinchRef.current = {
      distance,
      zoom: current.zoom,
      worldX: current.x + (midX - viewport.width / 2) / current.zoom,
      worldY: current.y + (midY - viewport.height / 2) / current.zoom,
    };
    dragRef.current = null;
  }, [viewport.height, viewport.width]);

  const pointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    movedRef.current = false;
    if (inertiaRafRef.current) { window.cancelAnimationFrame(inertiaRafRef.current); inertiaRafRef.current = null; }
    if (cameraTweenRafRef.current) { window.cancelAnimationFrame(cameraTweenRafRef.current); cameraTweenRafRef.current = null; }
    velocityRef.current = { x: 0, y: 0, at: performance.now() };
    viewportRectRef.current = event.currentTarget.getBoundingClientRect();
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);
    interactingRef.current = true;
    setDragging(true);
    if (pointersRef.current.size === 1) {
      dragRef.current = { id: event.pointerId, x: point.x, y: point.y, cameraX: cameraRef.current.x, cameraY: cameraRef.current.y };
    } else if (pointersRef.current.size === 2) beginPinch();
  }, [beginPinch, localPoint]);

  const pointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const point = localPoint(event);
    const previous = pointersRef.current.get(event.pointerId);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) > 2) movedRef.current = true;
    if (previous && pointersRef.current.size === 1) {
      const at = performance.now();
      const dt = Math.max(8, at - (velocityRef.current.at || at - 16));
      const instantX = -(point.x - previous.x) / cameraRef.current.zoom / dt;
      const instantY = -(point.y - previous.y) / cameraRef.current.zoom / dt;
      velocityRef.current = {
        x: velocityRef.current.x * .58 + instantX * .42,
        y: velocityRef.current.y * .58 + instantY * .42,
        at,
      };
    }
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const pinch = pinchRef.current;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinch.zoom * (distance / pinch.distance)));
      updateCamera({ x: pinch.worldX - (midX - viewport.width / 2) / zoom, y: pinch.worldY - (midY - viewport.height / 2) / zoom, zoom });
      return;
    }

    const start = dragRef.current;
    if (!start || start.id !== event.pointerId) return;
    updateCamera({
      ...cameraRef.current,
      x: start.cameraX - (point.x - start.x) / cameraRef.current.zoom,
      y: start.cameraY - (point.y - start.y) / cameraRef.current.zoom,
    });
  }, [localPoint, updateCamera, viewport.height, viewport.width]);

  const startInertia = useCallback(() => {
    if (!movedRef.current) return false;
    let vx = velocityRef.current.x;
    let vy = velocityRef.current.y;
    const speed = Math.hypot(vx, vy);
    if (speed < .045) return false;
    const maxSpeed = 1.65;
    const clamp = Math.min(1, maxSpeed / Math.max(.001, speed));
    vx *= clamp; vy *= clamp;
    let previousAt = performance.now();
    interactingRef.current = true;
    const frame = (at: number) => {
      const dt = Math.min(32, Math.max(8, at - previousAt));
      previousAt = at;
      const decay = Math.pow(.91, dt / 16.67);
      vx *= decay; vy *= decay;
      const current = cameraRef.current;
      updateCamera({ ...current, x: current.x + vx * dt, y: current.y + vy * dt });
      if (Math.hypot(vx, vy) > .018) inertiaRafRef.current = window.requestAnimationFrame(frame);
      else {
        inertiaRafRef.current = null;
        interactingRef.current = false;
        commitCameraState(true);
        kickExplore(70);
      }
    };
    inertiaRafRef.current = window.requestAnimationFrame(frame);
    return true;
  }, [commitCameraState, kickExplore, updateCamera]);

  const finishPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size >= 2) { beginPinch(); return; }
    pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      const [id, point] = [...pointersRef.current.entries()][0];
      dragRef.current = { id, x: point.x, y: point.y, cameraX: cameraRef.current.x, cameraY: cameraRef.current.y };
      return;
    }
    dragRef.current = null;
    viewportRectRef.current = null;
    setDragging(false);
    const inertial = startInertia();
    if (!inertial) {
      interactingRef.current = false;
      commitCameraState(true);
      kickExplore(90);
    }
  }, [beginPinch, commitCameraState, kickExplore, startInertia]);

  const wheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, [zoomAt]);

  const transform = useMemo(() => cameraTransform(camera, viewport), [camera, viewport]);
  const detail = camera.zoom < 0.50 ? "far" : camera.zoom < 1.02 ? "mid" : "near";
  const normalizedQuery = query.trim().replace(/^@/, "").toLocaleLowerCase("ru-RU");

  const mapCounts = useMemo(() => ({
    all: snapshot.islands.length,
    enemy: snapshot.islands.filter((island) => island.relation === "war").length,
    ally: snapshot.islands.filter((island) => island.relation === "allied").length,
    neutral: snapshot.islands.filter((island) => !island.relation && !island.isMine).length,
  }), [snapshot.islands]);
  const beginnerIsland = useMemo(() => snapshot.islands.find((island) => island.isBeginnerIsland) || null, [snapshot.islands]);
  const freeportIsland = useMemo(() => snapshot.islands.find((island) => island.isFreeport) || null, [snapshot.islands]);
  const nearbyIslands = useMemo(() => snapshot.islands
    .filter((island) => !island.isMine)
    .map((island) => ({ island, distance: Math.hypot(island.worldX - snapshot.state.worldX, island.worldY - snapshot.state.worldY) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4), [snapshot.islands, snapshot.state.worldX, snapshot.state.worldY]);

  const sortedIslands = useMemo(() => [...snapshot.islands].sort((a, b) => islandSize(a.memberCount, a.isFreeport) - islandSize(b.memberCount, b.isFreeport)), [snapshot.islands]);
  const visibleIslands = useMemo(() => {
    const halfW = viewport.width / (2 * camera.zoom) + 720;
    const halfH = viewport.height / (2 * camera.zoom) + 720;
    const matchesFilter = (island: IslandView) => island.isMine || selected?.id === island.id || mapFilter === "all" || (mapFilter === "enemy" && island.relation === "war") || (mapFilter === "ally" && island.relation === "allied") || (mapFilter === "neutral" && !island.relation && !island.isMine);
    const candidates = sortedIslands.filter((island) => matchesFilter(island) && Math.abs(island.worldX - camera.x) <= halfW && Math.abs(island.worldY - camera.y) <= halfH);
    const cap = detail === "far" ? 240 : detail === "mid" ? 240 : 300;
    if (candidates.length <= cap) return candidates;
    const nearest = [...candidates].sort((a, b) => Math.hypot(a.worldX - camera.x, a.worldY - camera.y) - Math.hypot(b.worldX - camera.x, b.worldY - camera.y)).slice(0, cap);
    for (const special of candidates.filter((island) => island.isMine || island.id === selected?.id)) if (!nearest.some((item) => item.id === special.id)) nearest.push(special);
    return nearest.sort((a, b) => islandSize(a.memberCount, a.isFreeport) - islandSize(b.memberCount, b.isFreeport));
  }, [sortedIslands, viewport.width, viewport.height, camera.x, camera.y, camera.zoom, detail, mapFilter, selected?.id]);

  const ordered = visibleIslands;
  const selectedReason = selected ? attackReason(snapshot, selected, now) : null;
  const selectedElo = selected ? eloDeltaPreview(snapshot.state.rating, selected.rating) : null;
  const selectedLeague = selected ? eloLeague(selected.rating) : null;
  const war = snapshot.activeBattle;

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return [];
    return snapshot.islands
      .filter((island) => island.name.toLocaleLowerCase("ru-RU").includes(normalizedQuery) || (island.stateUsername || "").toLocaleLowerCase("ru-RU").includes(normalizedQuery))
      .sort((a, b) => Math.hypot(a.worldX - camera.x, a.worldY - camera.y) - Math.hypot(b.worldX - camera.x, b.worldY - camera.y))
      .slice(0, 6);
  }, [snapshot.islands, normalizedQuery, camera.x, camera.y]);

  const minimapRange = 5400;
  const minimap = useMemo(() => {
    if (dragging) return [];
    return snapshot.islands
      .filter((item) => Math.abs(item.worldX - camera.x) < minimapRange && Math.abs(item.worldY - camera.y) < minimapRange)
      .slice(0, 96)
      .map((item) => ({ ...item, left: 50 + ((item.worldX - camera.x) / (minimapRange * 2)) * 100, top: 50 + ((item.worldY - camera.y) / (minimapRange * 2)) * 100 }));
  }, [snapshot.islands, camera.x, camera.y, dragging]);

  const jumpFromMinimap = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - rect.left) / rect.width - .5) * minimapRange * 2;
    const dy = ((event.clientY - rect.top) / rect.height - .5) * minimapRange * 2;
    animateCameraTo({ ...cameraRef.current, x: cameraRef.current.x + dx, y: cameraRef.current.y + dy }, 360);
  }, [animateCameraTo]);

  useEffect(() => {
    setSheetClosing(false);
    if (sheetCloseTimerRef.current) {
      window.clearTimeout(sheetCloseTimerRef.current);
      sheetCloseTimerRef.current = null;
    }
  }, [selected?.id]);

  const closeSelectedSheet = useCallback(() => {
    if (!selected || sheetClosing) return;
    setSheetClosing(true);
    try { navigator.vibrate?.(8); } catch { /* optional tactile hint */ }
    sheetCloseTimerRef.current = window.setTimeout(() => {
      onSelect(null);
      setSheetClosing(false);
      sheetCloseTimerRef.current = null;
    }, 210);
  }, [selected?.id, sheetClosing, onSelect]);

  return (
    <div className="island-map-screen game-map-screen">
      {war && (
        <button className="game-war-banner" type="button" onClick={onOpenBattle}>
          <span className="war-swords">⚔</span>
          <div><b>Идёт война</b><small>{war.attackerName} против {war.defenderName}</small></div>
          <strong>В БОЙ</strong>
        </button>
      )}

      <div
        ref={viewportRef}
        className={`game-ocean ${dragging ? "dragging" : ""} detail-${detail}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onWheel={wheel}
        onClick={() => { if (!movedRef.current && selected) closeSelectedSheet(); }}
      >
        <OceanCanvas cameraRef={cameraRef} interactingRef={interactingRef} viewport={viewport} reduced={detail === "far"} />
        <div className="ocean-depth-vignette" />
        <div className="world-ambient" aria-hidden="true">
          <i className="ambient-gull gull-a">⌁</i><i className="ambient-gull gull-b">⌁</i><i className="ambient-gull gull-c">⌁</i>
          <span className="ambient-current current-a"/><span className="ambient-current current-b"/>
          <span className="ambient-sail sail-a"><b/></span><span className="ambient-sail sail-b"><b/></span>
        </div>

        {radarOpen && (
          <aside className="map-radar-panel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <div className="map-radar-head"><div><small>РАДАР МИРА</small><b>Навигация по островам</b></div><button type="button" onClick={() => { setRadarOpen(false); setQuery(""); }} aria-label="Закрыть радар"><CloseIcon /></button></div>
            <label className="map-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или @юз" autoComplete="off" /></label>
            <div className="map-filter-row">
              {([
                ["all", "Все", mapCounts.all],
                ["enemy", "Враги", mapCounts.enemy],
                ["ally", "Союзы", mapCounts.ally],
                ["neutral", "Нейтр.", mapCounts.neutral],
              ] as Array<[MapFilter, string, number]>).map(([key, label, count]) => <button key={key} type="button" className={mapFilter === key ? "active" : ""} onClick={() => setMapFilter(key)}><b>{label}</b><small>{count}</small></button>)}
            </div>
            <div className="map-landmark-shortcuts">
              {freeportIsland && !freeportIsland.isMine && (
                <button className="map-beginner-shortcut map-freeport-shortcut" type="button" onClick={() => focusIsland(freeportIsland)}>
                  <span>⚓</span><div><b>Freeport</b><small>Нейтральный центр · выбрать на карте</small></div><i>›</i>
                </button>
              )}
              {beginnerIsland && !beginnerIsland.isMine && (
                <button className="map-beginner-shortcut" type="button" onClick={() => focusIsland(beginnerIsland)}>
                  <span>🧭</span><div><b>Остров новичков</b><small>Защищённая территория · выбрать на карте</small></div><i>›</i>
                </button>
              )}
            </div>
            {normalizedQuery && <div className="map-search-results">{searchResults.length ? searchResults.map((island) => <button type="button" key={island.id} onClick={() => focusIsland(island)}><span style={{ background: island.color }}>{island.emblem || island.name.slice(0, 1)}</span><div><b>{island.name}</b><small>{island.memberCount.toLocaleString("ru-RU")} участников · {island.rating} ELO</small></div><i>›</i></button>) : <p>Ничего не найдено</p>}</div>}
            <div className="map-radar-foot"><span><i />{visibleIslands.length} на экране</span><span>масштаб {Math.round(camera.zoom * 100)}%</span></div>
          </aside>
        )}

        <div ref={worldLayerRef} className="game-world-layer" style={{ transform }}>
          {ordered.map((island) => (
            <IslandNode
              key={island.id}
              island={island}
              selectedId={selected?.id || null}
              detail={detail}
              now={now}
              onSelect={onSelect}
              zoom={camera.zoom}
            />
          ))}
        </div>

        {!selected && !radarOpen && nearbyIslands.length > 0 && (
          <div className="game-map-nearby" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <span className="game-map-nearby-title">БЛИЖАЙШИЕ</span>
            <div>
              {nearbyIslands.map(({ island, distance }) => (
                <button type="button" key={island.id} onClick={() => focusIsland(island)}>
                  <i style={{ background: island.color }}>{island.emblem || island.name.slice(0, 1)}</i>
                  <span><b>{island.name}</b><small>{Math.max(1, Math.round(distance)).toLocaleString("ru-RU")} м · {island.rating} ELO</small></span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="game-map-tools game-map-tools-left">
          <button className="map-tool-home" type="button" onClick={(event) => { event.stopPropagation(); centerMine(); }} aria-label="Мой остров"><span>⌂</span></button>
          <button className={radarOpen ? "map-tool-radar active" : "map-tool-radar"} type="button" onClick={(event) => { event.stopPropagation(); setRadarOpen((value) => !value); }} aria-label="Радар и поиск" aria-expanded={radarOpen}><span>⌕</span></button>
        </div>
        <div className="game-map-tools game-map-tools-right">
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom + 0.14); }} aria-label="Приблизить"><span>＋</span></button>
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom - 0.14); }} aria-label="Отдалить"><span>−</span></button>
        </div>

        <div className="game-map-status" onClick={(event) => event.stopPropagation()}><b>{Math.round(camera.zoom * 100)}%</b><span>{visibleIslands.length}/{snapshot.islands.length}</span></div>
        <div className="game-minimap" onClick={jumpFromMinimap} title="Нажмите, чтобы переместиться">
          <div className="game-minimap-water">
            {minimap.map((item) => <i key={item.id} className={item.isMine ? "mine" : item.destroyedUntil ? "ruined" : ""} style={{ left: `${item.left}%`, top: `${item.top}%`, background: item.color }} />)}
            <span />
          </div>
        </div>
      </div>

      {selected && (
        <section className={`game-island-sheet ${sheetClosing ? "is-closing" : "is-opening"}`} style={{ ["--sheet-color" as any]: selected.color }}>
          <button className="sheet-close" type="button" onClick={closeSelectedSheet} aria-label="Закрыть"><CloseIcon /></button>
          <div className="sheet-island-id">
            <span className="sheet-avatar" style={{ background: selected.color }}>
              {selected.avatarUrl ? <Image src={selected.avatarUrl} alt="" width={52} height={52} unoptimized /> : selected.emblem}
            </span>
            <div className="sheet-title-copy">
              <small>{selectedLeague?.icon} {selectedLeague?.label}{selected.rank > 0 ? ` · место #${selected.rank}` : ""}</small>
              <h3>{selected.name}</h3>{selected.stateUsername && <em className="sheet-state-handle">@{selected.stateUsername}</em>}
              <p><b>{selected.memberCount.toLocaleString("ru-RU")}</b> участников <i>•</i> <b>{selected.rating}</b> ELO</p>
            </div>
            <span className={`sheet-relation-orb ${selected.relation || "neutral"}`} aria-hidden="true" />
          </div>
          <div className="sheet-integrity-track" aria-label={`Прочность ${selected.integrity}%`}><i style={{ width: `${selected.integrity}%` }} /></div>
          <div className="sheet-game-stats">
            <span><b>{selected.integrity}%</b><small>прочность</small></span>
            <span><b>{selected.wins}<em> / {selected.losses}</em></b><small>победы / поражения</small></span>
            <span><b>{selected.winStreak}</b><small>серия побед</small></span>
          </div>
          <div className="sheet-game-stats">
            <span><b>{selected.level}<em> / {selected.maxLevel}</em></b><small>уровень</small></span>
            <span><b>{selected.armyPower}<em> / {selected.defensePower}</em></b><small>армия / оборона</small></span>
            <span><b>{selected.stateSize.toFixed(2)}</b><small>размер · {selected.activePlayers} акт.</small></span>
          </div>
          <div className="sheet-status-row">
            {selected.isBeginnerIsland && <span className="sheet-status beginner">🧭 ОСТРОВ НОВИЧКОВ · ПОД ЗАЩИТОЙ</span>}
            {selected.isFreeport && <span className="sheet-status freeport">⚓ НЕЙТРАЛЬНЫЙ FREEPORT</span>}
            {selected.relation === "war" && <span className="sheet-status enemy">⚔ ВОЙНА</span>}
            {selected.relation === "allied" && <span className="sheet-status ally">◆ СОЮЗ</span>}
            {selected.relation === "truce" && <span className="sheet-status truce">◌ ПЕРЕМИРИЕ</span>}
            {selected.shieldUntil && timeLeft(selected.shieldUntil, now) && <span className="sheet-status shield">◈ ЩИТ {timeLeft(selected.shieldUntil, now)}</span>}
          </div>
          {!selected.isMine && !selected.isFreeport && (
            <button className="sheet-switch-state" type="button" onClick={() => onSwitchState(selected)}>
              <span>⇄ ПЕРЕЙТИ В «{selected.name.toLocaleUpperCase("ru-RU")}»</span>
              <small>Только для участников Telegram-чата этого государства</small>
            </button>
          )}
          {selected.isFreeport && !selected.isMine ? (
            <div className="sheet-freeport">⚓ Freeport нельзя атаковать. Это нейтральный хаб свободных игроков.</div>
          ) : selected.destroyedUntil && timeLeft(selected.destroyedUntil, now) ? (
            <div className="sheet-danger">☠ Остров восстанавливается · {timeLeft(selected.destroyedUntil, now)}</div>
          ) : selected.isMine ? (
            <button className="sheet-home" type="button" onClick={onOpenIsland}>
              <span>⌂ МОЙ ОСТРОВ</span><small>Инфраструктура, ремонт и развитие</small>
            </button>
          ) : (
            <div className="sheet-foreign-actions">
              <div className="sheet-war-box">
              <div className="sheet-war-types" aria-label="Тип операции">
                {(["raid", "siege", "territory"] as WarType[]).map((type) => <button key={type} type="button" className={warType === type ? "active" : ""} onClick={() => setWarType(type)} disabled={Boolean(selectedReason)}>{type === "raid" ? "Рейд" : type === "siege" ? "Осада" : "Территория"}</button>)}
              </div>
              <button className="sheet-attack" type="button" disabled={Boolean(selectedReason)} onClick={() => onAttack(selected, warType)}>
                <span>🗳 НА ГОЛОСОВАНИЕ · {warType === "raid" ? "РЕЙД" : warType === "siege" ? "ОСАДА" : "ТЕРРИТОРИЯ"}</span>
                <small>{selectedReason || `Голосование 10 мин · после одобрения: 120 топлива · 80 еды · бой ${warType === "raid" ? "15 мин" : warType === "territory" ? "20 мин" : "30 мин"}`}</small>
              </button>
              </div>
            </div>
          )}
        </section>
      )}

      {!selected && (() => {
        const feed = snapshot.worldFeed[0];
        if (!feed) return null;
        const age = Date.now() - new Date(feed.createdAt).getTime();
        if (age > 5 * 60 * 1000) return null;
        return (
          <div className="game-event-ticker">
            <span>{feed.kind.includes("alliance") ? "🤝" : feed.kind.includes("destroy") ? "☠" : "⚔"}</span>
            <p>{feed.text}</p>
            <small>LIVE</small>
          </div>
        );
      })()}
    </div>
  );
}

export const IslandMap = memo(IslandMapInner);
