"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { eloDeltaPreview, eloLeague } from "@/lib/elo";
import type { GameSnapshot, IslandView } from "@/lib/types";
import { IslandArt } from "@/components/game/island-art";

function islandSize(members: number) {
  return Math.max(112, Math.min(252, 86 + Math.sqrt(Math.max(1, members)) * 5.4));
}

function shortNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function timeLeft(iso?: string | null) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.max(1, Math.floor((ms % 3_600_000) / 60_000));
  return hours ? `${hours}ч ${minutes}м` : `${minutes}м`;
}

function attackReason(snapshot: GameSnapshot, island: IslandView) {
  if (island.isMine) return "Это ваш остров";
  if (!["president", "minister", "general"].includes(snapshot.player.role)) return "Атаку запускает командование";
  if (snapshot.activeBattle) return "Ваш флот уже участвует в битве";
  if (snapshot.state.destroyedUntil && new Date(snapshot.state.destroyedUntil).getTime() > Date.now()) return "Ваш остров восстанавливается";
  if (island.destroyedUntil && new Date(island.destroyedUntil).getTime() > Date.now()) return "Остров уже в руинах";
  if (island.shieldUntil && new Date(island.shieldUntil).getTime() > Date.now()) return "Защитный щит активен";
  if (island.relation === "allied") return "Союзный остров";
  if (island.relation === "truce") return "Действует перемирие";
  if (snapshot.state.nextAttackAt && new Date(snapshot.state.nextAttackAt).getTime() > Date.now()) return `Флот готовится · ${timeLeft(snapshot.state.nextAttackAt) || "скоро"}`;
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
};

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onExplore, onOpenBattle }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const dragRef = useRef<{ id: number; x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const exploreKickRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: 0.82 });
  const [camera, setCamera] = useState<Camera>(cameraRef.current);
  const [viewport, setViewport] = useState({ width: 390, height: 620 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { cameraRef.current = camera; }, [camera]);
  useEffect(() => () => { if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current); }, []);

  const kickExplore = useCallback((delay = 0) => {
    if (!onExplore) return;
    if (exploreKickRef.current) window.clearTimeout(exploreKickRef.current);
    exploreKickRef.current = window.setTimeout(() => {
      const current = cameraRef.current;
      onExplore(current.x, current.y, Math.min(6200, 3100 / current.zoom));
    }, delay);
  }, [onExplore]);

  const updateCamera = useCallback((next: Camera, explore = false) => {
    const normalized = { ...next, zoom: Math.max(0.38, Math.min(1.48, next.zoom)) };
    cameraRef.current = normalized;
    setCamera(normalized);
    if (explore) kickExplore(90);
  }, [kickExplore]);

  const zoomAt = useCallback((nextZoom: number, screenX = viewport.width / 2, screenY = viewport.height / 2, explore = true) => {
    const old = cameraRef.current;
    const zoom = Math.max(0.38, Math.min(1.48, nextZoom));
    const worldX = old.x + (screenX - viewport.width / 2) / old.zoom;
    const worldY = old.y + (screenY - viewport.height / 2) / old.zoom;
    updateCamera({
      x: worldX - (screenX - viewport.width / 2) / zoom,
      y: worldY - (screenY - viewport.height / 2) / zoom,
      zoom,
    }, explore);
  }, [updateCamera, viewport.height, viewport.width]);

  const centerMine = useCallback(() => {
    updateCamera({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: Math.max(0.78, cameraRef.current.zoom) }, true);
  }, [snapshot.state.worldX, snapshot.state.worldY, updateCamera]);

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
      const zoom = Math.max(0.38, Math.min(1.48, pinch.zoom * (distance / pinch.distance)));
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

  const visibleIslands = useMemo(() => {
    const halfW = viewport.width / (2 * camera.zoom) + 360;
    const halfH = viewport.height / (2 * camera.zoom) + 360;
    return snapshot.islands.filter((island) => Math.abs(island.worldX - camera.x) <= halfW && Math.abs(island.worldY - camera.y) <= halfH);
  }, [snapshot.islands, viewport.width, viewport.height, camera.x, camera.y, camera.zoom]);

  const ordered = useMemo(() => [...visibleIslands].sort((a, b) => islandSize(a.memberCount) - islandSize(b.memberCount)), [visibleIslands]);
  const detail = camera.zoom < 0.57 ? "far" : camera.zoom < 0.85 ? "mid" : "near";
  const selectedReason = selected ? attackReason(snapshot, selected) : null;
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
        style={{ ["--water-x" as any]: `${-camera.x * 0.06}px`, ["--water-y" as any]: `${-camera.y * 0.06}px` }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onWheel={wheel}
        onClick={() => { if (!movedRef.current) onSelect(null); }}
      >
        <div className="ocean-light ocean-light-one" />
        <div className="ocean-light ocean-light-two" />
        <div className="ocean-current current-one" />
        <div className="ocean-current current-two" />

        <div className="game-world-layer" style={{ transform }}>
          {ordered.map((island) => {
            const size = islandSize(island.memberCount);
            const ruined = Boolean(island.destroyedUntil && new Date(island.destroyedUntil).getTime() > Date.now());
            const league = eloLeague(island.rating);
            const showLabel = detail !== "far" || island.isMine || selected?.id === island.id || island.rank <= 5;
            return (
              <button
                type="button"
                key={island.id}
                className={`game-island-node ${island.isMine ? "mine" : ""} ${ruined ? "ruined" : ""} ${selected?.id === island.id ? "selected" : ""} ${island.relation ? `relation-${island.relation}` : ""}`}
                style={{ left: island.worldX, top: island.worldY, width: size, height: size * 0.69, ["--island-color" as any]: island.color }}
                onClick={(event) => { event.stopPropagation(); onSelect(island); }}
                aria-label={`${island.name}, ${island.memberCount} участников, рейтинг ${island.rating}`}
              >
                <IslandArt id={island.id} members={island.memberCount} color={island.color} integrity={island.integrity} ruined={ruined} selected={selected?.id === island.id} />
                {showLabel && (
                  <span className="game-island-label">
                    <span className="game-island-avatar" style={{ background: island.color }}>
                      {island.avatarUrl ? <Image src={island.avatarUrl} alt="" width={42} height={42} unoptimized draggable={false} /> : <b>{island.emblem || island.name.slice(0, 1)}</b>}
                    </span>
                    <span className="game-island-copy">
                      <strong>{island.name}</strong>
                      <small><span>👥 {shortNumber(island.memberCount)}</span><span>{league.icon} {island.rating}</span></small>
                    </span>
                    <i className={`game-status ${ruined ? "ruins" : island.relation === "war" ? "enemy" : island.relation === "allied" ? "ally" : "neutral"}`} />
                  </span>
                )}
                {island.integrity < 100 && !ruined && <span className="game-integrity"><i style={{ width: `${island.integrity}%` }} /></span>}
                {ruined && <span className="game-ruins-timer">РУИНЫ · {timeLeft(island.destroyedUntil) || "восстановление"}</span>}
              </button>
            );
          })}
        </div>

        <div className="game-map-tools game-map-tools-left">
          <button type="button" onClick={(event) => { event.stopPropagation(); centerMine(); }} aria-label="Мой остров">⌖</button>
        </div>
        <div className="game-map-tools game-map-tools-right">
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom + 0.14); }} aria-label="Приблизить">+</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); zoomAt(camera.zoom - 0.14); }} aria-label="Отдалить">−</button>
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
              {selected.avatarUrl ? <Image src={selected.avatarUrl} alt="" width={48} height={48} unoptimized /> : selected.emblem}
            </span>
            <div><small>{selectedLeague?.icon} {selectedLeague?.label} · #{selected.rank || "—"}</small><h3>{selected.name}</h3><p>{selected.memberCount} участников · ELO {selected.rating}</p></div>
          </div>
          <div className="sheet-game-stats">
            <span><b>{selected.integrity}%</b><small>прочность</small></span>
            <span><b>{selected.wins}</b><small>побед</small></span>
            <span><b>{selected.winStreak}</b><small>серия</small></span>
          </div>
          {selected.destroyedUntil && timeLeft(selected.destroyedUntil) ? (
            <div className="sheet-danger">☠ Остров восстанавливается · {timeLeft(selected.destroyedUntil)}</div>
          ) : selected.isMine ? (
            <div className="sheet-tip">Размер острова растёт вместе с количеством участников вашего Telegram-чата.</div>
          ) : (
            <button className="sheet-attack" type="button" disabled={Boolean(selectedReason)} onClick={() => onAttack(selected)}>
              <span>⚔ АТАКОВАТЬ</span>
              <small>{selectedReason || `ELO +${selectedElo?.win || 0} / −${selectedElo?.lose || 0}`}</small>
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
