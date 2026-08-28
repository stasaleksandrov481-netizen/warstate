"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import Image from "next/image";
import type { GameSnapshot, IslandView, WarType } from "@/lib/types";

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
  const emblem = String(state.emblem || "").trim();
  return emblem && emblem.length <= 3 ? emblem : displayName(state).slice(0, 1).toLocaleUpperCase("ru-RU");
}

const CastleNode = memo(function CastleNode({ state, detail, selected, onSelect }: { state: IslandView; detail: "far" | "mid" | "near"; selected: boolean; onSelect: (state: IslandView) => void }) {
  const ruined = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > Date.now());
  const size = Math.max(150, Math.min(260, 150 + Math.sqrt(Math.max(1, state.memberCount)) * 8));
  const style = {
    left: state.worldX,
    top: state.worldY,
    width: size,
    height: size * 0.78,
    "--state-color": state.color,
  } as CSSProperties;

  return (
    <button
      type="button"
      className={`continent-state lod-${detail} ${selected ? "selected" : ""} ${state.isMine ? "mine" : ""} ${ruined ? "ruined" : ""} relation-${state.relation || "neutral"}`}
      style={style}
      onClick={(event) => { event.stopPropagation(); onSelect(state); }}
      aria-label={`${displayName(state)}. ${relationText(state)}`}
    >
      <span className="territory-region" aria-hidden="true" />
      <span className="territory-wall" aria-hidden="true" />
      <span className="castle-structure" aria-hidden="true">
        <i className="castle-tower tower-left" /><i className="castle-tower tower-right" /><i className="castle-keep" /><i className="castle-gate" />
      </span>
      <span className="castle-crest" style={{ background: state.color }}>
        {state.avatarUrl ? <Image src={state.avatarUrl} alt="" width={46} height={46} unoptimized /> : crestText(state)}
      </span>
      {detail !== "far" && (
        <span className="castle-label">
          <b>{displayName(state)}</b>
          <small>{state.presidentName ? `Президент: ${state.presidentName}` : "Президент не назначен"}</small>
        </span>
      )}
      {detail === "near" && (
        <span className="castle-detail-card">
          <span><b>{compact.format(state.memberCount)}</b><small>население</small></span>
          <span><b>{compact.format(state.armyPower)}</b><small>армия</small></span>
          <span><b>{compact.format(state.treasuryCredits)}</b><small>казна</small></span>
          <span><b>{state.allianceCount}</b><small>союзы</small></span>
        </span>
      )}
    </button>
  );
});

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onSwitchState, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; camera: Camera } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const exploreTimer = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 390, height: 620 });
  const [camera, setCamera] = useState<Camera>(() => ({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: DEFAULT_ZOOM }));
  const [filter, setFilter] = useState<MapFilter>("all");
  const [query, setQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [warType, setWarType] = useState<WarType>("raid");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth || 390, height: element.clientHeight || 620 });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem("warstate-map-camera-v5");
      if (!stored) return;
      const parsed = JSON.parse(stored) as Camera;
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.zoom)) setCamera({ x: parsed.x, y: parsed.y, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, parsed.zoom)) });
    } catch { /* session storage is optional */ }
  }, []);

  useEffect(() => {
    try { window.sessionStorage.setItem("warstate-map-camera-v5", JSON.stringify(camera)); } catch { /* optional */ }
    if (!onExplore) return;
    if (exploreTimer.current) window.clearTimeout(exploreTimer.current);
    exploreTimer.current = window.setTimeout(() => onExplore(camera.x, camera.y, Math.min(6500, Math.max(2400, 3200 / camera.zoom))), 180);
    return () => { if (exploreTimer.current) window.clearTimeout(exploreTimer.current); };
  }, [camera, onExplore]);

  const bounds = useMemo(() => {
    if (!snapshot.islands.length) return { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 };
    return snapshot.islands.reduce((acc, state) => ({ minX: Math.min(acc.minX, state.worldX), maxX: Math.max(acc.maxX, state.worldX), minY: Math.min(acc.minY, state.worldY), maxY: Math.max(acc.maxY, state.worldY) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  }, [snapshot.islands]);

  const fitWorld = useCallback(() => {
    const spanX = Math.max(900, bounds.maxX - bounds.minX + 900);
    const spanY = Math.max(900, bounds.maxY - bounds.minY + 900);
    setCamera({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom: Math.max(MIN_ZOOM, Math.min(.7, Math.min(size.width / spanX, size.height / spanY))) });
  }, [bounds, size.height, size.width]);

  const focusState = useCallback((state: IslandView) => {
    setCamera((current) => ({ x: state.worldX, y: state.worldY, zoom: Math.max(.88, current.zoom) }));
    onSelect(state);
    setPanelOpen(false);
  }, [onSelect]);

  const centerMine = useCallback(() => {
    setCamera({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: .92 });
  }, [snapshot.state.worldX, snapshot.state.worldY]);

  const zoomAt = useCallback((nextZoom: number, screenX = size.width / 2, screenY = size.height / 2) => {
    setCamera((current) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
      const worldX = current.x + (screenX - size.width / 2) / current.zoom;
      const worldY = current.y + (screenY - size.height / 2) / current.zoom;
      return { x: worldX - (screenX - size.width / 2) / zoom, y: worldY - (screenY - size.height / 2) / zoom, zoom };
    });
  }, [size.height, size.width]);

  const localPoint = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const pointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input")) return;
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) dragRef.current = { id: event.pointerId, x: point.x, y: point.y, camera };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      pinchRef.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: camera.zoom, worldX: camera.x + (midX - size.width / 2) / camera.zoom, worldY: camera.y + (midY - size.height / 2) / camera.zoom };
      dragRef.current = null;
    }
  }, [camera, localPoint, size.height, size.width]);

  const pointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchRef.current.zoom * distance / pinchRef.current.distance));
      setCamera({ x: pinchRef.current.worldX - (midX - size.width / 2) / zoom, y: pinchRef.current.worldY - (midY - size.height / 2) / zoom, zoom });
      return;
    }
    const start = dragRef.current;
    if (!start || start.id !== event.pointerId) return;
    setCamera({ ...start.camera, x: start.camera.x - (point.x - start.x) / start.camera.zoom, y: start.camera.y - (point.y - start.y) / start.camera.zoom });
  }, [localPoint, size.height, size.width]);

  const pointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinchRef.current = null;
    if (pointers.current.size === 1) {
      const [id, point] = [...pointers.current.entries()][0];
      dragRef.current = { id, x: point.x, y: point.y, camera };
    } else dragRef.current = null;
  }, [camera]);

  const wheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(camera.zoom * (event.deltaY > 0 ? .9 : 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, [camera.zoom, zoomAt]);

  const detail: "far" | "mid" | "near" = camera.zoom < .52 ? "far" : camera.zoom < 1.02 ? "mid" : "near";
  const transform = `translate3d(${size.width / 2 - camera.x * camera.zoom}px, ${size.height / 2 - camera.y * camera.zoom}px, 0) scale(${camera.zoom})`;
  const normalizedQuery = query.trim().replace(/^@/, "").toLocaleLowerCase("ru-RU");
  const searchResults = useMemo(() => normalizedQuery ? snapshot.islands.filter((state) => displayName(state).toLocaleLowerCase("ru-RU").includes(normalizedQuery) || (state.stateUsername || "").toLocaleLowerCase("ru-RU").includes(normalizedQuery)).slice(0, 8) : [], [normalizedQuery, snapshot.islands]);
  const visibleStates = useMemo(() => snapshot.islands.filter((state) => state.isMine || selected?.id === state.id || filter === "all" || (filter === "enemy" && state.relation === "war") || (filter === "ally" && state.relation === "allied") || (filter === "neutral" && !state.relation)), [filter, selected?.id, snapshot.islands]);
  const allied = useMemo(() => snapshot.islands.filter((state) => state.relation === "allied" && !state.isMine), [snapshot.islands]);
  const mine = useMemo(() => snapshot.islands.find((state) => state.isMine) || null, [snapshot.islands]);
  const selectedReason = selected ? attackReason(snapshot, selected, now) : null;
  const activeBattle = snapshot.activeBattle && snapshot.activeBattle.status !== "resolved" && new Date(snapshot.activeBattle.endsAt).getTime() > now ? snapshot.activeBattle : null;

  return (
    <div className="continent-map-screen">
      {activeBattle && <button type="button" className="continent-war-alert" onClick={onOpenBattle}><span>⚔</span><div><small>АКТИВНЫЙ БОЙ</small><b>{activeBattle.attackerName} · {activeBattle.defenderName}</b></div><em>{timeLeft(activeBattle.endsAt, now)}</em></button>}
      <div
        ref={viewportRef}
        className={`continent-viewport lod-${detail}`}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onWheel={wheel}
        onClick={() => onSelect(null)}
      >
        <div className="continent-background" aria-hidden="true"><i className="terrain ridge-a"/><i className="terrain ridge-b"/><i className="terrain forest-a"/><i className="terrain forest-b"/><i className="terrain plain-a"/></div>
        <div className="continent-world" style={{ transform }}>
          <svg className="alliance-network" width="10000" height="10000" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
            {mine && allied.map((ally) => {
              const mx = (mine.worldX + ally.worldX) / 2;
              const my = (mine.worldY + ally.worldY) / 2;
              return <g key={ally.id}><line x1={mine.worldX} y1={mine.worldY} x2={ally.worldX} y2={ally.worldY}/><circle cx={mx} cy={my} r={16}/><text x={mx} y={my + 5} textAnchor="middle">◆</text></g>;
            })}
          </svg>
          {visibleStates.map((state) => <CastleNode key={state.id} state={state} detail={detail} selected={selected?.id === state.id} onSelect={onSelect} />)}
        </div>

        <div className="continent-map-head" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <div><small>МИРОВАЯ КАРТА</small><b>Материк государств</b></div><span className="lod-badge">LOD {detail === "far" ? "1" : detail === "mid" ? "2" : "3"}</span>
        </div>

        <div className="continent-map-tools left" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={centerMine} aria-label="Моё государство">⌂</button>
          <button type="button" onClick={() => setPanelOpen((value) => !value)} aria-label="Поиск и фильтры">⌕</button>
          <button type="button" onClick={fitWorld} aria-label="Показать весь материк">▣</button>
        </div>
        <div className="continent-map-tools right" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => zoomAt(camera.zoom + .16)}>＋</button>
          <button type="button" onClick={() => zoomAt(camera.zoom - .16)}>−</button>
        </div>

        {panelOpen && <aside className="continent-radar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <div className="continent-radar-head"><div><small>НАВИГАЦИЯ</small><b>Государства</b></div><button type="button" onClick={() => setPanelOpen(false)}>×</button></div>
          <label className="continent-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Название или @юз" /></label>
          <div className="continent-filters">
            {([['all','Все'],['enemy','Противники'],['ally','Союзники'],['neutral','Нейтральные']] as Array<[MapFilter,string]>).map(([key,label]) => <button type="button" key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}
          </div>
          {normalizedQuery && <div className="continent-search-results">{searchResults.length ? searchResults.map((state) => <button type="button" key={state.id} onClick={() => focusState(state)}><i style={{ background: state.color }}>{crestText(state)}</i><span><b>{displayName(state)}</b><small>{state.memberCount.toLocaleString("ru-RU")} участников · {state.rating} ELO</small></span></button>) : <p>Ничего не найдено</p>}</div>}
          <div className="continent-map-key"><span><i className="ally"/>Союз</span><span><i className="enemy"/>Война</span><span><i className="mine"/>Ваше государство</span></div>
        </aside>}
      </div>

      {selected && <section className="state-inspector" style={{ "--state-color": selected.color } as CSSProperties}>
        <button type="button" className="state-inspector-close" onClick={() => onSelect(null)} aria-label="Закрыть">×</button>
        <div className="state-inspector-title"><span style={{ background: selected.color }}>{selected.avatarUrl ? <Image src={selected.avatarUrl} alt="" width={58} height={58} unoptimized /> : crestText(selected)}</span><div><small>{relationText(selected)}</small><h3>{displayName(selected)}</h3>{selected.stateUsername && <em>@{selected.stateUsername}</em>}</div></div>
        <div className="state-inspector-grid">
          <span><b>{selected.memberCount.toLocaleString("ru-RU")}</b><small>население</small></span>
          <span><b>{selected.armyPower.toLocaleString("ru-RU")}</b><small>армия</small></span>
          <span><b>{selected.treasuryCredits.toLocaleString("ru-RU")}</b><small>казна</small></span>
          <span><b>{selected.allianceCount}</b><small>союзы</small></span>
          <span><b>{selected.integrity}%</b><small>прочность</small></span>
          <span><b>{selected.rating}</b><small>ELO</small></span>
        </div>
        <div className="state-inspector-meta"><span>Президент: <b>{selected.presidentName || "не назначен"}</b></span><span>Активны: <b>{selected.activePlayers}</b></span></div>
        {!selected.isMine && !selected.isFreeport && <button type="button" className="state-switch" onClick={() => onSwitchState(selected)}>Перейти в государство<small>Бот проверит членство в Telegram-чате</small></button>}
        {selected.isMine ? <button type="button" className="state-primary" onClick={onOpenIsland}>Открыть замок<small>Казна, армия, инфраструктура</small></button> : selected.isFreeport || selected.isBeginnerIsland ? <div className="state-protected">Эта территория защищена и не участвует в атаках.</div> : <div className="state-war-actions">
          <div>{(["raid","siege","territory"] as WarType[]).map((type) => <button type="button" key={type} className={warType === type ? "active" : ""} onClick={() => setWarType(type)} disabled={Boolean(selectedReason)}>{type === "raid" ? "Рейд" : type === "siege" ? "Осада" : "Территория"}</button>)}</div>
          <button type="button" className="state-primary danger" disabled={Boolean(selectedReason)} onClick={() => onAttack(selected, warType)}>Запустить голосование<small>{selectedReason || "Решение принимают граждане государства"}</small></button>
        </div>}
      </section>}
    </div>
  );
}

export const IslandMap = memo(IslandMapInner);
