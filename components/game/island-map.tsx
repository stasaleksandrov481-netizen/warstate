"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { eloDeltaPreview, eloLeague } from "@/lib/elo";
import type { GameSnapshot, IslandView } from "@/lib/types";
import { IslandArt } from "@/components/game/island-art";
import { OceanCanvas } from "@/components/game/ocean-canvas";

function islandSize(members: number, freeport = false) {
  if (freeport) return 860;
  // Every additional citizen expands the physical footprint, but sub-linear
  // growth keeps huge supergroups from swallowing the whole viewport.
  const population = Math.max(1, members);
  return Math.max(190, Math.min(1320, 150 + Math.pow(population, 0.47) * 22));
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
  if (island.isFreeport) return "Freeport — нейтральная территория";
  if (!["president", "minister", "general"].includes(snapshot.player.role)) return "Атаку запускает командование";
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

type Camera = { x: number; y: number; zoom: number };
type PointerPoint = { x: number; y: number };

type Props = {
  snapshot: GameSnapshot;
  selected: IslandView | null;
  onSelect: (island: IslandView | null) => void;
  onAttack: (island: IslandView) => void;
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
  onSelect,
}: {
  island: IslandView;
  selectedId: string | null;
  detail: "far" | "mid" | "near";
  now: number;
  onSelect: (island: IslandView) => void;
}) {
  const size = islandSize(island.memberCount, island.isFreeport);
  const ruined = Boolean(island.destroyedUntil && new Date(island.destroyedUntil).getTime() > now);
  const selected = selectedId === island.id;
  const league = eloLeague(island.rating);
  const showLabel = detail !== "far" || island.isMine || selected || (island.rank > 0 && island.rank <= 5);
  const relationLabel = island.isFreeport ? "НЕЙТРАЛЬНО" : island.relation === "war" ? "ВРАГ" : island.relation === "allied" ? "СОЮЗ" : island.relation === "truce" ? "МИР" : null;
  return (
    <button
      type="button"
      className={`game-island-node ${island.isFreeport ? "freeport" : ""} ${island.isMine ? "mine" : ""} ${ruined ? "ruined" : ""} ${selected ? "selected" : ""} ${island.relation ? `relation-${island.relation}` : ""}`}
      style={{ left: island.worldX, top: island.worldY, width: size, height: size * 0.69, ["--island-color" as string]: island.color }}
      onClick={(event) => { event.stopPropagation(); onSelect(island); }}
      aria-label={`${island.name}, ${island.memberCount} участников, рейтинг ${island.rating}`}
    >
      <IslandArt id={island.id} members={island.memberCount} color={island.color} integrity={island.integrity} ruined={ruined} selected={selected} detail={detail} freeport={island.isFreeport} />
      {showLabel && (
        <span className="game-island-label">
          <span className="game-island-avatar" style={{ background: island.color }}>
            {island.avatarUrl ? <Image src={island.avatarUrl} alt="" width={42} height={42} unoptimized draggable={false} /> : <b>{island.emblem || island.name.slice(0, 1)}</b>}
          </span>
          <span className="game-island-copy">
            <strong>{island.name}</strong>
            <small><span>👥 {COMPACT_NUMBER.format(island.memberCount)}</span><span>{league.icon} {island.rating}</span></small>
          </span>
          {relationLabel && <em className={`relation-tag tag-${island.relation}`}>{relationLabel}</em>}
          <i className={`game-status ${island.isFreeport ? "freeport" : ruined ? "ruins" : island.relation === "war" ? "enemy" : island.relation === "allied" ? "ally" : "neutral"}`} />
        </span>
      )}
      {island.integrity < 100 && !ruined && <span className="game-integrity"><i style={{ width: `${island.integrity}%` }} /></span>}
      {ruined && <span className="game-ruins-timer">РУИНЫ · {timeLeft(island.destroyedUntil, now) || "восстановление"}</span>}
    </button>
  );
});

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const dragRef = useRef<{ id: number; x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const exploreKickRef = useRef<number | null>(null);
  const cameraRafRef = useRef<number | null>(null);
  const pendingCameraRef = useRef<Camera | null>(null);
  const movedRef = useRef(false);
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: snapshot.state.isFreeport ? 0.72 : 0.88 });
  const [camera, setCamera] = useState<Camera>(cameraRef.current);
  const [viewport, setViewport] = useState({ width: 390, height: 620 });
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { cameraRef.current = camera; }, [camera]);
  useEffect(() => () => {
    if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current);
    if (cameraRafRef.current) window.cancelAnimationFrame(cameraRafRef.current);
  }, []);

  const kickExplore = useCallback((delay = 0) => {
    if (!onExplore) return;
    if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current);
    exploreKickRef.current = window.setTimeout(() => {
      const current = cameraRef.current;
      onExplore(current.x, current.y, Math.min(6200, 3100 / current.zoom));
    }, delay);
  }, [onExplore]);

  const updateCamera = useCallback((next: Camera, explore = false) => {
    const normalized = { ...next, zoom: Math.max(0.30, Math.min(1.60, next.zoom)) };
    cameraRef.current = normalized;
    pendingCameraRef.current = normalized;
    if (!cameraRafRef.current) {
      cameraRafRef.current = window.requestAnimationFrame(() => {
        cameraRafRef.current = null;
        const pending = pendingCameraRef.current;
        if (pending) setCamera(pending);
      });
    }
    if (explore) kickExplore(90);
  }, [kickExplore]);

  const zoomAt = useCallback((nextZoom: number, screenX = viewport.width / 2, screenY = viewport.height / 2, explore = true) => {
    const old = cameraRef.current;
    const zoom = Math.max(0.30, Math.min(1.60, nextZoom));
    const worldX = old.x + (screenX - viewport.width / 2) / old.zoom;
    const worldY = old.y + (screenY - viewport.height / 2) / old.zoom;
    updateCamera({
      x: worldX - (screenX - viewport.width / 2) / zoom,
      y: worldY - (screenY - viewport.height / 2) / zoom,
      zoom,
    }, explore);
  }, [updateCamera, viewport.height, viewport.width]);

  const centerMine = useCallback(() => {
    updateCamera({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: Math.max(snapshot.state.isFreeport ? 0.76 : 0.98, cameraRef.current.zoom) }, true);
  }, [snapshot.state.isFreeport, snapshot.state.worldX, snapshot.state.worldY, updateCamera]);

  const localPoint = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
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
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);
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
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const pinch = pinchRef.current;
      const zoom = Math.max(0.30, Math.min(1.60, pinch.zoom * (distance / pinch.distance)));
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
    setDragging(false);
    kickExplore(80);
  }, [beginPinch, kickExplore]);

  const wheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, [zoomAt]);

  const transform = useMemo(() => {
    const tx = viewport.width / 2 - camera.x * camera.zoom;
    const ty = viewport.height / 2 - camera.y * camera.zoom;
    return `translate3d(${tx}px, ${ty}px, 0) scale(${camera.zoom})`;
  }, [viewport.width, viewport.height, camera.x, camera.y, camera.zoom]);

  const sortedIslands = useMemo(() => [...snapshot.islands].sort((a, b) => islandSize(a.memberCount, a.isFreeport) - islandSize(b.memberCount, b.isFreeport)), [snapshot.islands]);
  const visibleIslands = useMemo(() => {
    const halfW = viewport.width / (2 * camera.zoom) + 620;
    const halfH = viewport.height / (2 * camera.zoom) + 620;
    return sortedIslands.filter((island) => Math.abs(island.worldX - camera.x) <= halfW && Math.abs(island.worldY - camera.y) <= halfH);
  }, [sortedIslands, viewport.width, viewport.height, camera.x, camera.y, camera.zoom]);

  const ordered = visibleIslands;
  const detail = camera.zoom < 0.44 ? "far" : camera.zoom < 0.78 ? "mid" : "near";
  const selectedReason = selected ? attackReason(snapshot, selected, now) : null;
  const selectedElo = selected ? eloDeltaPreview(snapshot.state.rating, selected.rating) : null;
  const selectedLeague = selected ? eloLeague(selected.rating) : null;
  const war = snapshot.activeBattle;

  const minimap = useMemo(() => {
    const range = 5400;
    return snapshot.islands
      .filter((item) => Math.abs(item.worldX - camera.x) < range && Math.abs(item.worldY - camera.y) < range)
      .slice(0, 160)
      .map((item) => ({ ...item, left: 50 + ((item.worldX - camera.x) / (range * 2)) * 100, top: 50 + ((item.worldY - camera.y) / (range * 2)) * 100 }));
  }, [snapshot.islands, camera.x, camera.y]);

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
        onClick={() => { if (!movedRef.current) onSelect(null); }}
      >
        <OceanCanvas camera={camera} viewport={viewport} reduced={detail === "far"} />
        <div className="ocean-depth-vignette" />

        <div className="game-world-layer" style={{ transform }}>
          {ordered.map((island) => (
            <IslandNode
              key={island.id}
              island={island}
              selectedId={selected?.id || null}
              detail={detail}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </div>

        <div className="game-map-tools game-map-tools-left">
          <button className="map-tool-home" type="button" onClick={(event) => { event.stopPropagation(); centerMine(); }} aria-label="Мой остров"><span>⌂</span></button>
        </div>
        <div className="game-map-tools game-map-tools-right">
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom + 0.14); }} aria-label="Приблизить"><span>＋</span></button>
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom - 0.14); }} aria-label="Отдалить"><span>−</span></button>
        </div>

        <div className="game-minimap" onClick={(event) => event.stopPropagation()}>
          <div className="game-minimap-water">
            {minimap.map((item) => <i key={item.id} className={item.isMine ? "mine" : item.destroyedUntil ? "ruined" : ""} style={{ left: `${item.left}%`, top: `${item.top}%`, background: item.color }} />)}
            <span />
          </div>
        </div>
      </div>

      {selected && (
        <section className="game-island-sheet" style={{ ["--sheet-color" as any]: selected.color }}>
          <button className="sheet-close" type="button" onClick={() => onSelect(null)}>×</button>
          <div className="sheet-island-id">
            <span className="sheet-avatar" style={{ background: selected.color }}>
              {selected.avatarUrl ? <Image src={selected.avatarUrl} alt="" width={52} height={52} unoptimized /> : selected.emblem}
            </span>
            <div className="sheet-title-copy">
              <small>{selectedLeague?.icon} {selectedLeague?.label}{selected.rank > 0 ? ` · место #${selected.rank}` : ""}</small>
              <h3>{selected.name}</h3>
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
          <div className="sheet-status-row">
            {selected.isFreeport && <span className="sheet-status freeport">⚓ НЕЙТРАЛЬНЫЙ FREEPORT</span>}
            {selected.relation === "war" && <span className="sheet-status enemy">⚔ ВОЙНА</span>}
            {selected.relation === "allied" && <span className="sheet-status ally">◆ СОЮЗ</span>}
            {selected.relation === "truce" && <span className="sheet-status truce">◌ ПЕРЕМИРИЕ</span>}
            {selected.shieldUntil && timeLeft(selected.shieldUntil, now) && <span className="sheet-status shield">◈ ЩИТ {timeLeft(selected.shieldUntil, now)}</span>}
          </div>
          {selected.isFreeport && !selected.isMine ? (
            <div className="sheet-freeport">⚓ Freeport нельзя атаковать. Это нейтральный хаб свободных игроков.</div>
          ) : selected.destroyedUntil && timeLeft(selected.destroyedUntil, now) ? (
            <div className="sheet-danger">☠ Остров восстанавливается · {timeLeft(selected.destroyedUntil, now)}</div>
          ) : selected.isMine ? (
            <button className="sheet-home" type="button" onClick={onOpenIsland}>
              <span>⌂ МОЙ ОСТРОВ</span><small>Инфраструктура, ремонт и развитие</small>
            </button>
          ) : (
            <button className="sheet-attack" type="button" disabled={Boolean(selectedReason)} onClick={() => onAttack(selected)}>
              <span>⚔ АТАКОВАТЬ</span>
              <small>{selectedReason || `120 топлива · 80 еды · ELO +${selectedElo?.win || 0} / −${selectedElo?.lose || 0}`}</small>
            </button>
          )}
        </section>
      )}

      {!selected && snapshot.worldFeed[0] && (
        <div className="game-event-ticker">
          <span>{snapshot.worldFeed[0].kind.includes("alliance") ? "🤝" : snapshot.worldFeed[0].kind.includes("destroy") ? "☠" : "⚔"}</span>
          <p>{snapshot.worldFeed[0].text}</p>
          <small>LIVE</small>
        </div>
      )}
    </div>
  );
}

export const IslandMap = memo(IslandMapInner);
