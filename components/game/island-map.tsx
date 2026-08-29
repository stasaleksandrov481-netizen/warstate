"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import Image from "next/image";
import type { GameSnapshot, IslandView, WarType } from "@/lib/types";
import { stateMarkText } from "@/lib/visual";

const MIN_ZOOM = 0.045;
const MAX_ZOOM = 1.8;
const DEFAULT_ZOOM = 0.62;
const CLICK_THRESHOLD_MOUSE = 6;
const CLICK_THRESHOLD_TOUCH = 10;

type Camera = { x: number; y: number; zoom: number };
type MapFilter = "all" | "enemy" | "ally" | "neutral";
type Lod = "far" | "mid" | "near";
type RenderItem = { state: IslandView; x: number; y: number; clusterCount: number };

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

function lodForZoom(zoom: number): Lod {
  return zoom < .52 ? "far" : zoom < 1.02 ? "mid" : "near";
}

function markerSize(state: IslandView, selectedId?: string | null) {
  if (state.id === selectedId) return 106;
  if (state.isMine) return 102;
  return 96;
}

function priority(state: IslandView, selectedId?: string | null) {
  if (state.id === selectedId) return 10_000_000;
  if (state.isMine) return 9_000_000;
  if (state.relation === "war") return 8_000_000 + state.rating;
  if (state.relation === "allied") return 7_000_000 + state.rating;
  if (state.isBeginnerIsland || state.isFreeport) return 6_000_000 + state.rating;
  return state.rating * 100 + state.memberCount;
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

function buildRenderItems(states: IslandView[], cam: Camera, width: number, height: number, selectedId?: string | null): RenderItem[] {
  const candidates = states
    .map((state) => ({
      state,
      x: width / 2 + (state.worldX - cam.x) * cam.zoom,
      y: height / 2 + (state.worldY - cam.y) * cam.zoom,
    }))
    .filter((item) => item.x > -130 && item.x < width + 130 && item.y > -140 && item.y < height + 180);

  // Far zoom must keep castles readable. We therefore declutter in screen space:
  // world positions are still exact, but only one castle occupies a visual cell.
  // Search/focus can still reach every state, and special states always win a cell.
  const cell = cam.zoom < .34 ? 112 : cam.zoom < .52 ? 102 : cam.zoom < .72 ? 76 : 0;
  if (!cell) return candidates.map((item) => ({ ...item, clusterCount: 1 }));

  const buckets = new Map<string, Array<typeof candidates[number]>>();
  for (const item of candidates) {
    const key = `${Math.floor(item.x / cell)}:${Math.floor(item.y / cell)}`;
    const bucket = buckets.get(key) || [];
    bucket.push(item);
    buckets.set(key, bucket);
  }

  const result: RenderItem[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => priority(b.state, selectedId) - priority(a.state, selectedId));
    result.push({ ...bucket[0], clusterCount: bucket.length });
  }
  return result;
}

const TERRAIN_PATCHES = [
  [-4300,-2900,900,430,-.22,"#314e25"],[-2100,-3400,620,360,.18,"#79934d"],[500,-3200,1000,420,-.08,"#425f2b"],
  [2900,-2500,760,390,.30,"#6f8248"],[-3500,-700,720,330,.12,"#526f34"],[-1100,-600,960,450,-.18,"#78914c"],
  [1900,-300,800,360,.04,"#334f26"],[3900,500,650,320,-.24,"#6e8346"],[-3000,1900,820,390,-.16,"#3d5c2b"],
  [-500,2300,1000,430,.18,"#708a48"],[2300,2600,780,350,-.08,"#405e2b"],[4100,3200,600,300,.22,"#778b4b"],
] as const;

function drawWorldTerrain(ctx: CanvasRenderingContext2D, cam: Camera, width: number, height: number) {
  const worldToScreen = (x: number, y: number) => ({ x: width / 2 + (x - cam.x) * cam.zoom, y: height / 2 + (y - cam.y) * cam.zoom });

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#5f873b");
  bg.addColorStop(.55, "#4d7730");
  bg.addColorStop(1, "#3d6028");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  for (const [wx, wy, rx, ry, rotation, color] of TERRAIN_PATCHES) {
    const p = worldToScreen(wx, wy);
    const sx = rx * cam.zoom;
    const sy = ry * cam.zoom;
    if (p.x + sx < -80 || p.x - sx > width + 80 || p.y + sy < -80 || p.y - sy > height + 80) continue;
    ctx.save();
    ctx.globalAlpha = .28;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, Math.max(18, sx), Math.max(12, sy), rotation, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Roads use world coordinates and therefore move with the continent, never with the camera chrome.
  if (cam.zoom >= .34) {
    const roads: Array<[number,number,number,number]> = [[-4300,-2200,3800,1600],[-3100,2500,4200,-1200],[-900,-4200,1200,3900]];
    ctx.save();
    ctx.globalAlpha = .20;
    ctx.strokeStyle = "#d5bd7b";
    ctx.lineWidth = clamp(4 * cam.zoom, 1, 3.2);
    for (const [x1,y1,x2,y2] of roads) {
      const a = worldToScreen(x1,y1), b = worldToScreen(x2,y2);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // Fine grass is generated from visible WORLD cells. Panning changes which world cells are visible,
  // not the grass pattern itself, fixing the old "grass glued to camera" illusion.
  if (cam.zoom >= .72) {
    const spacing = 130;
    const halfWorldW = width / (2 * cam.zoom) + spacing;
    const halfWorldH = height / (2 * cam.zoom) + spacing;
    const minX = Math.floor((cam.x - halfWorldW) / spacing) * spacing;
    const maxX = Math.ceil((cam.x + halfWorldW) / spacing) * spacing;
    const minY = Math.floor((cam.y - halfWorldH) / spacing) * spacing;
    const maxY = Math.ceil((cam.y + halfWorldH) / spacing) * spacing;
    ctx.save();
    ctx.strokeStyle = "rgba(33,78,27,.38)";
    ctx.lineWidth = 1;
    for (let wy = minY; wy <= maxY; wy += spacing) {
      for (let wx = minX; wx <= maxX; wx += spacing) {
        const seed = Math.abs(((wx / spacing) * 73856093) ^ ((wy / spacing) * 19349663));
        const ox = ((seed % 61) - 30) * .55;
        const oy = (((seed >> 4) % 61) - 30) * .45;
        const p = worldToScreen(wx + ox, wy + oy);
        const blade = clamp(4.8 * cam.zoom, 3, 8);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(p.x - blade * .35, p.y - blade, p.x - blade * .7, p.y - blade * .45);
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(p.x + blade * .28, p.y - blade * 1.05, p.x + blade * .62, p.y - blade * .42);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
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
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * .035);
  ctx.strokeStyle = "rgba(248,225,164,.92)";
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

function drawCastle(ctx: CanvasRenderingContext2D, item: RenderItem, lod: Lod, selectedId?: string | null) {
  const { state, x, y, clusterCount } = item;
  const s = markerSize(state, selectedId);
  const selected = state.id === selectedId;
  const ruined = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > Date.now());
  const relation = state.relation;

  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = ruined ? .56 : 1;

  // Cheap far renderer: no gradients, no blur, no avatar decode. This is the critical FPS path.
  if (lod === "far") {
    ctx.fillStyle = relation === "war" ? "rgba(111,52,38,.72)" : relation === "allied" ? "rgba(58,102,43,.72)" : "rgba(42,55,31,.70)";
    ctx.beginPath(); ctx.ellipse(0, s*.28, s*.42, s*.12, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#aaa18d";
    ctx.fillRect(-s*.28,-s*.06,s*.56,s*.34);
    ctx.fillRect(-s*.33,-s*.22,s*.17,s*.50);
    ctx.fillRect(s*.16,-s*.22,s*.17,s*.50);
    ctx.fillRect(-s*.10,-s*.31,s*.20,s*.59);
    ctx.fillStyle = "#d2c7ad";
    for (const tx of [-s*.33,-s*.10,s*.16]) {
      for (let i=0;i<3;i++) ctx.fillRect(tx+i*s*.055,-s*.28,s*.032,s*.065);
    }
    ctx.fillStyle = "#30241b";
    ctx.beginPath(); ctx.arc(0,s*.19,s*.055,Math.PI,0); ctx.lineTo(s*.055,s*.28); ctx.lineTo(-s*.055,s*.28); ctx.closePath(); ctx.fill();
  } else {
    ctx.shadowColor = selected || state.isMine ? "rgba(244,205,105,.58)" : "rgba(0,0,0,.34)";
    ctx.shadowBlur = selected || state.isMine ? 14 : 7;
    ctx.shadowOffsetY = 7;
    ctx.fillStyle = relation === "war" ? "rgba(116,48,35,.55)" : relation === "allied" ? "rgba(76,120,52,.58)" : "rgba(38,51,29,.55)";
    ctx.beginPath(); ctx.ellipse(0,s*.28,s*.44,s*.13,0,0,Math.PI*2); ctx.fill();
    ctx.shadowColor = "transparent";

    const stone = ctx.createLinearGradient(0,-s*.35,0,s*.32);
    stone.addColorStop(0,"#e5dcc4"); stone.addColorStop(.42,"#aaa18e"); stone.addColorStop(1,"#625b50");
    ctx.fillStyle = stone;
    roundRect(ctx,-s*.30,-s*.08,s*.60,s*.38,s*.025); ctx.fill();
    for (const tx of [-s*.34,s*.18]) { roundRect(ctx,tx,-s*.27,s*.16,s*.55,s*.018); ctx.fill(); }
    roundRect(ctx,-s*.13,-s*.31,s*.26,s*.58,s*.018); ctx.fill();
    ctx.fillStyle="#d8ceb6";
    for (const tx of [-s*.34,-s*.13,s*.18]) for(let b=0;b<3;b++) ctx.fillRect(tx+b*s*.055,-s*.33,s*.032,s*.065);
    ctx.fillStyle="#30241b";
    ctx.beginPath(); ctx.arc(0,s*.18,s*.06,Math.PI,0); ctx.lineTo(s*.06,s*.28); ctx.lineTo(-s*.06,s*.28); ctx.closePath(); ctx.fill();
    ctx.strokeStyle="#4a3928"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(-s*.27,-s*.25); ctx.lineTo(-s*.27,-s*.48); ctx.moveTo(s*.27,-s*.25); ctx.lineTo(s*.27,-s*.48); ctx.stroke();
    ctx.fillStyle=state.color || "#8d6840";
    ctx.beginPath(); ctx.moveTo(-s*.27,-s*.47); ctx.lineTo(-s*.08,-s*.43); ctx.lineTo(-s*.27,-s*.37); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(s*.27,-s*.47); ctx.lineTo(s*.08,-s*.43); ctx.lineTo(s*.27,-s*.37); ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  if (selected) {
    ctx.save(); ctx.strokeStyle="#f2cf75"; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(x,y,s*.55,0,Math.PI*2); ctx.stroke(); ctx.restore();
  }

  if (clusterCount > 1) {
    ctx.save();
    ctx.fillStyle="#281f16"; ctx.strokeStyle="#e6c46d"; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(x+s*.38,y-s*.36,13,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle="#fff0c6"; ctx.font="800 9px system-ui"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(`+${clusterCount-1}`,x+s*.38,y-s*.36+.5); ctx.restore();
  }
}

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onSwitchState, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ width: 390, height: 620, dpr: 1 });
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: DEFAULT_ZOOM });
  const rafRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ id: number; x: number; y: number; camera: Camera; lastX: number; lastY: number; lastAt: number; vx: number; vy: number } | null>(null);
  const gestureRef = useRef({ moved: false, pinched: false });
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const exploreTimer = useRef<number | null>(null);
  const lodRef = useRef<Lod>(lodForZoom(DEFAULT_ZOOM));
  const [lod, setLod] = useState<Lod>(lodRef.current);
  const [filter, setFilter] = useState<MapFilter>("all");
  const [query, setQuery] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [warType, setWarType] = useState<WarType>("raid");
  const [now, setNow] = useState(() => Date.now());

  const bounds = useMemo(() => {
    if (!snapshot.islands.length) return { minX:-3000,maxX:3000,minY:-3000,maxY:3000 };
    return snapshot.islands.reduce((acc,state)=>({minX:Math.min(acc.minX,state.worldX),maxX:Math.max(acc.maxX,state.worldX),minY:Math.min(acc.minY,state.worldY),maxY:Math.max(acc.maxY,state.worldY)}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});
  }, [snapshot.islands]);

  const normalizedQuery = query.trim().replace(/^@/, "").toLocaleLowerCase("ru-RU");
  const searchResults = useMemo(() => normalizedQuery ? snapshot.islands.filter((state)=>displayName(state).toLocaleLowerCase("ru-RU").includes(normalizedQuery)||(state.stateUsername||"").toLocaleLowerCase("ru-RU").includes(normalizedQuery)).slice(0,8) : [], [normalizedQuery,snapshot.islands]);
  const visibleStates = useMemo(() => snapshot.islands.filter((state)=>state.isMine||selected?.id===state.id||filter==="all"||(filter==="enemy"&&state.relation==="war")||(filter==="ally"&&state.relation==="allied")||(filter==="neutral"&&!state.relation)), [filter,selected?.id,snapshot.islands]);
  const allied = useMemo(() => snapshot.islands.filter((state)=>state.relation==="allied"&&!state.isMine), [snapshot.islands]);
  const mine = useMemo(() => snapshot.islands.find((state)=>state.isMine)||null, [snapshot.islands]);
  const selectedReason = selected ? attackReason(snapshot,selected,now) : null;
  const activeBattle = snapshot.activeBattle && snapshot.activeBattle.status!=="resolved" && new Date(snapshot.activeBattle.endsAt).getTime()>now ? snapshot.activeBattle : null;

  const updateLod = useCallback((zoom:number) => {
    const next = lodForZoom(zoom);
    if (next !== lodRef.current) { lodRef.current=next; setLod(next); }
  }, []);

  const draw = useCallback(() => {
    const canvas=canvasRef.current;
    if (!canvas) return;
    const {width,height,dpr}=sizeRef.current;
    const ctx=canvas.getContext("2d",{alpha:false});
    if (!ctx) return;
    const cam=cameraRef.current;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    drawWorldTerrain(ctx,cam,width,height);

    const worldToScreen=(x:number,y:number)=>({x:width/2+(x-cam.x)*cam.zoom,y:height/2+(y-cam.y)*cam.zoom});
    if (cam.zoom>=.43 && mine) {
      const a=worldToScreen(mine.worldX,mine.worldY);
      ctx.save(); ctx.strokeStyle="rgba(239,209,128,.54)"; ctx.lineWidth=1.5; ctx.setLineDash([8,8]);
      for(const ally of allied){ const b=worldToScreen(ally.worldX,ally.worldY); if((a.x< -50&&b.x< -50)||(a.x>width+50&&b.x>width+50)||(a.y< -50&&b.y< -50)||(a.y>height+50&&b.y>height+50)) continue; ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke(); }
      ctx.restore();
    }

    const items=buildRenderItems(visibleStates,cam,width,height,selected?.id);
    const currentLod=lodForZoom(cam.zoom);
    for(const item of items){
      drawCastle(ctx,item,currentLod,selected?.id);
      const state=item.state;
      const s=markerSize(state,selected?.id);
      drawShield(ctx,item.x,item.y-s*.43,currentLod==="far"?26:30,state.color||"#7d6342",crestText(state));

      if(currentLod!=="far" || state.isMine || state.id===selected?.id){
        const labelY=item.y+s*.62;
        ctx.save();
        ctx.font=`800 ${currentLod==="near"?13:11}px Georgia, serif`;
        const title=displayName(state);
        const handle=state.stateUsername ? `@${state.stateUsername}` : "юз не создан";
        const textW=Math.min(230,Math.max(118,Math.max(ctx.measureText(title).width,ctx.measureText(handle).width)+24));
        const h=currentLod==="near"?41:36;
        ctx.fillStyle="rgba(24,20,14,.94)"; roundRect(ctx,item.x-textW/2,labelY,textW,h,9);ctx.fill();
        ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#f4e8c9";ctx.fillText(title,item.x,labelY+11);
        ctx.font="700 8px system-ui";ctx.fillStyle="#c6ad77";ctx.fillText(handle,item.x,labelY+25);
        ctx.restore();
      }
    }
  }, [allied,mine,selected?.id,visibleStates]);

  const requestDraw = useCallback(() => {
    if(rafRef.current!=null) return;
    rafRef.current=window.requestAnimationFrame(()=>{rafRef.current=null;draw();});
  }, [draw]);

  const stopAnimation = useCallback(() => {
    if(animationRef.current!=null){window.cancelAnimationFrame(animationRef.current);animationRef.current=null;}
  }, []);

  const persistAndExplore = useCallback((camera:Camera, explore=true) => {
    try{window.sessionStorage.setItem("warstate-map-camera-v7",JSON.stringify(camera));}catch{/* optional */}
    updateLod(camera.zoom);
    if(explore&&onExplore){
      if(exploreTimer.current!=null) window.clearTimeout(exploreTimer.current);
      exploreTimer.current=window.setTimeout(()=>onExplore(camera.x,camera.y,Math.min(9000,Math.max(2400,3200/camera.zoom))),180);
    }
  }, [onExplore,updateLod]);

  const animateCameraTo = useCallback((target:Camera,duration=260,explore=true) => {
    stopAnimation();
    const from={...cameraRef.current};
    const started=performance.now();
    const frame=(at:number)=>{
      const t=clamp((at-started)/duration,0,1);
      const eased=1-Math.pow(1-t,3);
      cameraRef.current={x:from.x+(target.x-from.x)*eased,y:from.y+(target.y-from.y)*eased,zoom:from.zoom+(target.zoom-from.zoom)*eased};
      updateLod(cameraRef.current.zoom);requestDraw();
      if(t<1) animationRef.current=window.requestAnimationFrame(frame);
      else{animationRef.current=null;persistAndExplore(cameraRef.current,explore);}
    };
    animationRef.current=window.requestAnimationFrame(frame);
  }, [persistAndExplore,requestDraw,stopAnimation,updateLod]);

  const startInertia = useCallback((vx:number,vy:number) => {
    stopAnimation();
    const started=performance.now();
    let previous=started;
    const frame=(at:number)=>{
      const dt=Math.min(32,at-previous);previous=at;
      const elapsed=at-started;
      const decay=Math.pow(.90,dt/16.67);
      vx*=decay;vy*=decay;
      if(elapsed>720||Math.hypot(vx,vy)<.015){animationRef.current=null;persistAndExplore(cameraRef.current,true);return;}
      cameraRef.current={...cameraRef.current,x:cameraRef.current.x+vx*dt,y:cameraRef.current.y+vy*dt};
      requestDraw();animationRef.current=window.requestAnimationFrame(frame);
    };
    animationRef.current=window.requestAnimationFrame(frame);
  }, [persistAndExplore,requestDraw,stopAnimation]);

  useEffect(()=>{
    const el=viewportRef.current,canvas=canvasRef.current;if(!el||!canvas)return;
    const update=()=>{const width=el.clientWidth||390,height=el.clientHeight||620,dpr=Math.min(1.75,window.devicePixelRatio||1);sizeRef.current={width,height,dpr};canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;requestDraw();};
    update();const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect();
  },[requestDraw]);

  useEffect(()=>{requestDraw();},[requestDraw,snapshot.islands,selected?.id,filter]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30_000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{
    try{const stored=window.sessionStorage.getItem("warstate-map-camera-v7")||window.sessionStorage.getItem("warstate-map-camera-v6");if(stored){const parsed=JSON.parse(stored) as Camera;if(Number.isFinite(parsed.x)&&Number.isFinite(parsed.y)&&Number.isFinite(parsed.zoom))cameraRef.current={x:parsed.x,y:parsed.y,zoom:clamp(parsed.zoom,MIN_ZOOM,MAX_ZOOM)};}}catch{/* optional */}
    updateLod(cameraRef.current.zoom);requestDraw();
    return()=>{if(rafRef.current!=null)window.cancelAnimationFrame(rafRef.current);stopAnimation();if(exploreTimer.current!=null)window.clearTimeout(exploreTimer.current);};
  },[requestDraw,stopAnimation,updateLod]);

  const localPoint=useCallback((event:ReactPointerEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};},[]);

  const findStateAt=useCallback((screenX:number,screenY:number)=>{
    const items=buildRenderItems(visibleStates,cameraRef.current,sizeRef.current.width,sizeRef.current.height,selected?.id);
    let best:IslandView|null=null,bestDist=Infinity;
    for(const item of items){const d=Math.hypot(item.x-screenX,item.y-screenY);const hit=markerSize(item.state,selected?.id)*.48;if(d<hit&&d<bestDist){best=item.state;bestDist=d;}}
    return best;
  },[selected?.id,visibleStates]);

  const pointerDown=useCallback((event:ReactPointerEvent<HTMLDivElement>)=>{
    if((event.target as HTMLElement).closest("button,input,aside"))return;
    stopAnimation();const point=localPoint(event);event.currentTarget.setPointerCapture(event.pointerId);pointers.current.set(event.pointerId,point);
    if(pointers.current.size===1){gestureRef.current={moved:false,pinched:false};dragRef.current={id:event.pointerId,x:point.x,y:point.y,camera:{...cameraRef.current},lastX:point.x,lastY:point.y,lastAt:performance.now(),vx:0,vy:0};}
    if(pointers.current.size===2){gestureRef.current.pinched=true;const[a,b]=[...pointers.current.values()];const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,c=cameraRef.current;pinchRef.current={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom:c.zoom,worldX:c.x+(midX-sizeRef.current.width/2)/c.zoom,worldY:c.y+(midY-sizeRef.current.height/2)/c.zoom};dragRef.current=null;}
  },[localPoint,stopAnimation]);

  const pointerMove=useCallback((event:ReactPointerEvent<HTMLDivElement>)=>{
    if(!pointers.current.has(event.pointerId))return;const point=localPoint(event);pointers.current.set(event.pointerId,point);
    if(pointers.current.size>=2&&pinchRef.current){const[a,b]=[...pointers.current.values()];const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,distance=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),pinch=pinchRef.current,zoom=clamp(pinch.zoom*distance/pinch.distance,MIN_ZOOM,MAX_ZOOM);cameraRef.current={x:pinch.worldX-(midX-sizeRef.current.width/2)/zoom,y:pinch.worldY-(midY-sizeRef.current.height/2)/zoom,zoom};updateLod(zoom);requestDraw();return;}
    const drag=dragRef.current;if(!drag||drag.id!==event.pointerId)return;
    const threshold=event.pointerType==="touch"?CLICK_THRESHOLD_TOUCH:CLICK_THRESHOLD_MOUSE;if(Math.hypot(point.x-drag.x,point.y-drag.y)>threshold)gestureRef.current.moved=true;
    const at=performance.now(),dt=Math.max(1,at-drag.lastAt),dx=point.x-drag.lastX,dy=point.y-drag.lastY;
    drag.vx=drag.vx*.68+(-dx/drag.camera.zoom/dt)*.32;drag.vy=drag.vy*.68+(-dy/drag.camera.zoom/dt)*.32;drag.lastX=point.x;drag.lastY=point.y;drag.lastAt=at;
    cameraRef.current={...drag.camera,x:drag.camera.x-(point.x-drag.x)/drag.camera.zoom,y:drag.camera.y-(point.y-drag.y)/drag.camera.zoom};requestDraw();
  },[localPoint,requestDraw,updateLod]);

  const finishPointer=useCallback((event:ReactPointerEvent<HTMLDivElement>,cancelled=false)=>{
    const point=pointers.current.get(event.pointerId);const drag=dragRef.current;pointers.current.delete(event.pointerId);
    if(pointers.current.size<2)pinchRef.current=null;
    if(pointers.current.size===1){const[id,p]=[...pointers.current.entries()][0];dragRef.current={id,x:p.x,y:p.y,camera:{...cameraRef.current},lastX:p.x,lastY:p.y,lastAt:performance.now(),vx:0,vy:0};return;}
    dragRef.current=null;persistAndExplore(cameraRef.current,false);
    if(cancelled||gestureRef.current.pinched)return;
    if(point&&drag&&!gestureRef.current.moved){const state=findStateAt(point.x,point.y);onSelect(state||null);return;}
    if(drag&&gestureRef.current.moved)startInertia(drag.vx,drag.vy);
  },[findStateAt,onSelect,persistAndExplore,startInertia]);

  const zoomAt=useCallback((nextZoom:number,screenX=sizeRef.current.width/2,screenY=sizeRef.current.height/2,animated=false)=>{
    const current=cameraRef.current,zoom=clamp(nextZoom,MIN_ZOOM,MAX_ZOOM),worldX=current.x+(screenX-sizeRef.current.width/2)/current.zoom,worldY=current.y+(screenY-sizeRef.current.height/2)/current.zoom,target={x:worldX-(screenX-sizeRef.current.width/2)/zoom,y:worldY-(screenY-sizeRef.current.height/2)/zoom,zoom};
    if(animated){animateCameraTo(target,180,false);return;}cameraRef.current=target;updateLod(zoom);requestDraw();persistAndExplore(target,false);
  },[animateCameraTo,persistAndExplore,requestDraw,updateLod]);

  const wheel=useCallback((event:ReactWheelEvent<HTMLDivElement>)=>{event.preventDefault();stopAnimation();const rect=event.currentTarget.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top,factor=Math.exp(-event.deltaY*.00135);zoomAt(cameraRef.current.zoom*factor,x,y,false);},[stopAnimation,zoomAt]);
  const fitWorld=useCallback(()=>{const spanX=Math.max(900,bounds.maxX-bounds.minX+1300),spanY=Math.max(900,bounds.maxY-bounds.minY+1300),zoom=clamp(Math.min(.72,Math.min(sizeRef.current.width/spanX,sizeRef.current.height/spanY)),MIN_ZOOM,.72);animateCameraTo({x:(bounds.minX+bounds.maxX)/2,y:(bounds.minY+bounds.maxY)/2,zoom},320,true);},[animateCameraTo,bounds]);
  const centerMine=useCallback(()=>animateCameraTo({x:snapshot.state.worldX,y:snapshot.state.worldY,zoom:.92},260,true),[animateCameraTo,snapshot.state.worldX,snapshot.state.worldY]);
  const focusState=useCallback((state:IslandView)=>{animateCameraTo({x:state.worldX,y:state.worldY,zoom:Math.max(.88,cameraRef.current.zoom)},280,true);onSelect(state);setPanelOpen(false);},[animateCameraTo,onSelect]);

  return <div className="continent-map-screen">
    {activeBattle&&<button type="button" className="continent-war-alert" onClick={onOpenBattle}><span>⚔</span><div><small>АКТИВНЫЙ БОЙ</small><b>{activeBattle.attackerName} · {activeBattle.defenderName}</b></div><em>{timeLeft(activeBattle.endsAt,now)}</em></button>}
    <div ref={viewportRef} className={`continent-viewport lod-${lod}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(e)=>finishPointer(e,false)} onPointerCancel={(e)=>finishPointer(e,true)} onWheel={wheel}>
      <canvas ref={canvasRef} className="continent-map-canvas" aria-label="Стратегическая карта государств" />
      <div className="continent-map-head" onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>e.stopPropagation()}><div><small>МИРОВАЯ КАРТА</small><b>Материк государств</b></div><span className="lod-badge">LOD {lod==="far"?"1":lod==="mid"?"2":"3"}</span></div>
      <div className="continent-map-tools left" onClick={(e)=>e.stopPropagation()}><button type="button" onClick={centerMine} aria-label="Моё государство">⌂</button><button type="button" onClick={()=>setPanelOpen(v=>!v)} aria-label="Поиск и фильтры">⌕</button><button type="button" onClick={fitWorld} aria-label="Показать весь материк">▣</button></div>
      <div className="continent-map-tools right" onClick={(e)=>e.stopPropagation()}><button type="button" onClick={()=>zoomAt(cameraRef.current.zoom+.16,undefined,undefined,true)}>＋</button><button type="button" onClick={()=>zoomAt(cameraRef.current.zoom-.16,undefined,undefined,true)}>−</button></div>
      {panelOpen&&<aside className="continent-radar" onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>e.stopPropagation()}>
        <div className="continent-radar-head"><div><small>НАВИГАЦИЯ</small><b>Государства</b></div><button type="button" onClick={()=>setPanelOpen(false)}>×</button></div>
        <label className="continent-search"><span>⌕</span><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Название или @юз" /></label>
        <div className="continent-filters">{([['all','Все'],['enemy','Противники'],['ally','Союзники'],['neutral','Нейтральные']] as Array<[MapFilter,string]>).map(([key,label])=><button type="button" key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{label}</button>)}</div>
        {normalizedQuery&&<div className="continent-search-results">{searchResults.length?searchResults.map((state)=><button type="button" key={state.id} onClick={()=>focusState(state)}><i style={{background:state.color}}>{crestText(state)}</i><span><b>{displayName(state)}</b><small>{state.stateUsername?`@${state.stateUsername} · `:""}{state.memberCount.toLocaleString("ru-RU")} жителей · {state.rating} ELO</small></span></button>):<p>Ничего не найдено</p>}</div>}
        <div className="continent-map-key"><span><i className="ally"/>Союз</span><span><i className="enemy"/>Война</span><span><i className="mine"/>Ваше государство</span></div>
      </aside>}
    </div>

    {selected&&<section className="state-inspector" style={{"--state-color":selected.color} as CSSProperties}>
      <button type="button" className="state-inspector-close" onClick={()=>onSelect(null)} aria-label="Закрыть">×</button>
      <div className="state-inspector-title"><span style={{background:selected.color}}>{selected.avatarUrl?<Image src={selected.avatarUrl} alt="" width={64} height={64} unoptimized/>:crestText(selected)}</span><div><small>{relationText(selected)}</small><h3>{displayName(selected)}</h3><em>{selected.stateUsername?`@${selected.stateUsername}`:"Юз государства не создан"}</em><p>{selected.presidentName?`Правитель: ${selected.presidentName}`:"Правитель ещё не назначен"}</p></div></div>
      <div className="state-inspector-grid"><span><b>{selected.memberCount.toLocaleString("ru-RU")}</b><small>население</small></span><span><b>{selected.armyPower.toLocaleString("ru-RU")}</b><small>армия</small></span><span><b>{selected.treasuryCredits.toLocaleString("ru-RU")}</b><small>казна</small></span><span><b>{selected.allianceCount}</b><small>союзы</small></span><span><b>{selected.integrity}%</b><small>прочность</small></span><span><b>{selected.rating}</b><small>ELO</small></span></div>
      <div className="state-inspector-meta"><span>Активный гарнизон: <b>{selected.activePlayers}</b></span><span>Баланс побед: <b>{selected.wins}:{selected.losses}</b></span><span>Серия: <b>x{selected.winStreak}</b></span></div>
      {!selected.isMine&&!selected.isFreeport&&<button type="button" className="state-switch" onClick={()=>onSwitchState(selected)}>Перейти в государство<small>Бот проверит членство в Telegram-чате</small></button>}
      {selected.isMine?<button type="button" className="state-primary" onClick={onOpenIsland}>Открыть замок<small>Казна, армия, инфраструктура</small></button>:selected.isFreeport||selected.isBeginnerIsland?<div className="state-protected">Эта территория защищена и не участвует в атаках.</div>:<div className="state-war-actions"><div>{(["raid","siege","territory"] as WarType[]).map((type)=><button type="button" key={type} className={warType===type?"active":""} onClick={()=>setWarType(type)} disabled={Boolean(selectedReason)}>{type==="raid"?"Рейд":type==="siege"?"Осада":"Территория"}</button>)}</div><button type="button" className="state-primary danger" disabled={Boolean(selectedReason)} onClick={()=>onAttack(selected,warType)}>Запустить голосование<small>{selectedReason||"Решение принимают граждане государства"}</small></button></div>}
    </section>}
  </div>;
}

export const IslandMap = memo(IslandMapInner);
