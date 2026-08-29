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
type TerrainBufferCache = { canvas: HTMLCanvasElement; anchor: Camera; width: number; height: number; dpr: number; marginX: number; marginY: number };

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
  const bufferX = width * .25;
  const bufferY = height * .25;
  let candidates = states
    .map((state) => ({
      state,
      x: width / 2 + (state.worldX - cam.x) * cam.zoom,
      y: height / 2 + (state.worldY - cam.y) * cam.zoom,
    }))
    .filter((item) => item.x > -bufferX && item.x < width + bufferX && item.y > -bufferY && item.y < height + bufferY);

  // At maximum zoom-in one state owns the scene. Prefer the selected state;
  // otherwise focus the state nearest the camera center. This prevents nearby
  // castles from flooding the close-up while preserving a hard max marker scale.
  if (cam.zoom >= 1.45) {
    const selectedCandidate = selectedId ? candidates.find((item) => item.state.id === selectedId) : null;
    candidates = selectedCandidate
      ? [selectedCandidate]
      : [...candidates].sort((a,b) => Math.hypot(a.x-width/2,a.y-height/2)-Math.hypot(b.x-width/2,b.y-height/2)).slice(0,1);
  }

  // Far zoom must keep castles readable. We therefore declutter in screen space:
  // world positions are still exact, but only one castle occupies a visual cell.
  // Search/focus can still reach every state, and special states always win a cell.
  const cell = cam.zoom < .16 ? 144 : cam.zoom < .34 ? 118 : cam.zoom < .52 ? 104 : cam.zoom < .72 ? 78 : 0;
  if (!cell) return candidates.map((item) => ({ ...item, clusterCount: 1 }));

  const buckets = new Map<string, Array<typeof candidates[number]>>();
  // Anchor decluttering cells to WORLD coordinates. Screen-space cells changed
  // whenever the camera panned, making representatives pop in/out even though
  // the underlying states had not moved. World anchoring keeps pan stable.
  const worldCell = cell / Math.max(cam.zoom, MIN_ZOOM);
  for (const item of candidates) {
    const key = `${Math.floor(item.state.worldX / worldCell)}:${Math.floor(item.state.worldY / worldCell)}`;
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

  // Deterministic world-space forests. Tree graphics come from the shared atlas, so
  // dozens of trees cost drawImage calls instead of rebuilding paths every frame.
  if (cam.zoom >= .28) {
    const atlas = getMapSpriteAtlas();
    if (atlas) {
      const spacing = cam.zoom < .55 ? 420 : 280;
      const halfWorldW = width / (2 * cam.zoom) + spacing * 2;
      const halfWorldH = height / (2 * cam.zoom) + spacing * 2;
      const minX = Math.floor((cam.x - halfWorldW) / spacing) * spacing;
      const maxX = Math.ceil((cam.x + halfWorldW) / spacing) * spacing;
      const minY = Math.floor((cam.y - halfWorldH) / spacing) * spacing;
      const maxY = Math.ceil((cam.y + halfWorldH) / spacing) * spacing;
      for (let wy=minY; wy<=maxY; wy+=spacing) {
        for (let wx=minX; wx<=maxX; wx+=spacing) {
          const seed=Math.abs(((wx/spacing)*83492791)^((wy/spacing)*2971215073));
          if(seed%5>1) continue;
          const ox=((seed%101)-50)*1.7, oy=(((seed>>5)%101)-50)*1.4;
          const p=worldToScreen(wx+ox,wy+oy);
          const size=clamp(18*cam.zoom,7,21);
          ctx.globalAlpha=.55;
          ctx.drawImage(atlas.canvas,atlas.tree.x,atlas.tree.y,atlas.tree.w,atlas.tree.h,p.x-size*.5,p.y-size,size,size*1.45);
          ctx.globalAlpha=1;
        }
      }
    }
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


function clampCameraToWorld(camera: Camera, bounds: { minX:number; maxX:number; minY:number; maxY:number }, width: number, height: number) {
  const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM);
  const padding = 900;
  const viewW = width / zoom;
  const viewH = height / zoom;
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  let x = camera.x;
  let y = camera.y;

  if (viewW >= worldW + padding * 2) x = centerX;
  else x = clamp(x, bounds.minX - padding + viewW / 2, bounds.maxX + padding - viewW / 2);

  if (viewH >= worldH + padding * 2) y = centerY;
  else y = clamp(y, bounds.minY - padding + viewH / 2, bounds.maxY + padding - viewH / 2);

  return { x, y, zoom };
}

function fillPolygon(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, fill: string, stroke?: string) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function drawIsoBox(ctx: CanvasRenderingContext2D, x: number, baseY: number, w: number, h: number, depth: number, front: string, side: string, top: string) {
  const dx = depth * .56;
  const dy = depth * .34;
  const left = x - w / 2;
  const right = x + w / 2;
  const topY = baseY - h;
  fillPolygon(ctx, [[left,topY],[right,topY],[right+dx,topY-dy],[left+dx,topY-dy]], top, 'rgba(65,53,42,.75)');
  fillPolygon(ctx, [[right,topY],[right,baseY],[right+dx,baseY-dy],[right+dx,topY-dy]], side, 'rgba(59,48,39,.75)');
  fillPolygon(ctx, [[left,topY],[right,topY],[right,baseY],[left,baseY]], front, 'rgba(70,58,46,.82)');
}

function drawIsoRoof(ctx: CanvasRenderingContext2D, x: number, topY: number, w: number, depth: number, height: number, color: string) {
  const dx = depth * .56;
  const dy = depth * .34;
  const peakX = x + dx * .28;
  const peakY = topY - height - dy * .35;
  fillPolygon(ctx, [[x-w/2,topY],[x+w/2,topY],[peakX,peakY]], color, 'rgba(62,46,34,.74)');
  fillPolygon(ctx, [[x+w/2,topY],[x+w/2+dx,topY-dy],[peakX,peakY]], 'rgba(108,70,43,.95)', 'rgba(62,46,34,.70)');
}


type MapSpriteAtlas = { canvas: HTMLCanvasElement; castle: Record<"far"|"mid"|"near", { x:number; y:number; w:number; h:number }>; tree: { x:number; y:number; w:number; h:number } };
let mapSpriteAtlasCache: MapSpriteAtlas | null = null;

function getMapSpriteAtlas(): MapSpriteAtlas | null {
  if (typeof document === "undefined") return null;
  if (mapSpriteAtlasCache) return mapSpriteAtlasCache;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 150;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const slots = { far:{x:0,y:0,w:140,h:140}, mid:{x:150,y:0,w:140,h:140}, near:{x:300,y:0,w:140,h:140} } as const;
  const render = (slot:{x:number;y:number;w:number;h:number}, lod:"far"|"mid"|"near") => {
    ctx.save();
    ctx.translate(slot.x + slot.w/2, slot.y + slot.h*.72);
    const s = 100;
    if (lod === "far") {
      drawIsoBox(ctx,-s*.17,s*.20,s*.24,s*.34,s*.12,'#9f9889','#665f55','#c8bea8');
      drawIsoBox(ctx, s*.17,s*.20,s*.24,s*.34,s*.12,'#9f9889','#665f55','#c8bea8');
      drawIsoBox(ctx,0,s*.18,s*.30,s*.44,s*.15,'#aaa291','#6d655a','#d0c6af');
      drawIsoRoof(ctx,0,-s*.26,s*.30,s*.15,s*.12,'#8f6b42');
    } else {
      drawIsoBox(ctx,0,s*.18,s*.34,s*.56,s*.20,'#b7ae9c','#6d665b','#ddd2ba');
      drawIsoRoof(ctx,0,-s*.38,s*.34,s*.20,s*.15,'#8f6b42');
      drawIsoBox(ctx,0,s*.24,s*.56,s*.30,s*.16,'#a39b8c','#625c53','#c9bea7');
      drawIsoBox(ctx,-s*.27,s*.24,s*.23,s*.48,s*.16,'#ada596','#665f55','#d1c6ae');
      drawIsoBox(ctx, s*.27,s*.24,s*.23,s*.48,s*.16,'#ada596','#665f55','#d1c6ae');
      drawIsoRoof(ctx,-s*.27,-s*.24,s*.23,s*.16,s*.11,'#8f6b42');
      drawIsoRoof(ctx, s*.27,-s*.24,s*.23,s*.16,s*.11,'#8f6b42');
      ctx.fillStyle='#2f241d'; ctx.beginPath(); ctx.arc(0,s*.10,s*.065,Math.PI,0); ctx.lineTo(s*.065,s*.24);ctx.lineTo(-s*.065,s*.24);ctx.closePath();ctx.fill();
      if (lod === "near") { ctx.fillStyle='rgba(244,207,112,.72)'; for(const wx of [-s*.26,-s*.08,s*.10,s*.28]) ctx.fillRect(wx,-s*.05,s*.035,s*.055); }
    }
    ctx.restore();
  };
  render(slots.far,"far"); render(slots.mid,"mid"); render(slots.near,"near");
  const tree={x:445,y:12,w:30,h:44};
  ctx.save();ctx.translate(tree.x+tree.w/2,tree.y+tree.h);
  ctx.fillStyle='#5a4028';ctx.fillRect(-2,-14,4,14);
  ctx.fillStyle='#244b20';ctx.beginPath();ctx.arc(0,-26,11,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#3c6d2c';ctx.beginPath();ctx.arc(-4,-31,7,0,Math.PI*2);ctx.fill();
  ctx.restore();
  mapSpriteAtlasCache={canvas,castle:slots,tree};
  return mapSpriteAtlasCache;
}
function drawCastle(ctx: CanvasRenderingContext2D, item: RenderItem, lod: Lod, selectedId?: string | null) {
  const { state, x, y, clusterCount } = item;
  const s = markerSize(state, selectedId);
  const selected = state.id === selectedId;
  const ruined = Boolean(state.destroyedUntil && new Date(state.destroyedUntil).getTime() > Date.now());
  const relation = state.relation;

  ctx.save();
  ctx.globalAlpha = ruined ? .58 : 1;
  ctx.fillStyle = 'rgba(24,30,18,.28)';
  ctx.beginPath(); ctx.ellipse(x+s*.06,y+s*.31,s*.46,s*.15,-.05,0,Math.PI*2); ctx.fill();
  const territoryColor = relation === 'war' ? 'rgba(118,54,38,.64)' : relation === 'allied' ? 'rgba(58,105,44,.64)' : 'rgba(50,69,35,.62)';
  ctx.fillStyle=territoryColor; ctx.beginPath(); ctx.ellipse(x,y+s*.27,s*.48,s*.16,-.04,0,Math.PI*2); ctx.fill();

  const atlas=getMapSpriteAtlas();
  if(atlas){
    const sprite=atlas.castle[lod];
    const drawSize=s*1.34;
    ctx.save();
    if(selected||state.isMine){ctx.shadowColor='rgba(244,205,105,.50)';ctx.shadowBlur=14;ctx.shadowOffsetY=6;}
    else {ctx.shadowColor='rgba(0,0,0,.28)';ctx.shadowBlur=7;ctx.shadowOffsetY=6;}
    ctx.drawImage(atlas.canvas,sprite.x,sprite.y,sprite.w,sprite.h,x-drawSize/2,y-drawSize*.72,drawSize,drawSize);
    ctx.restore();
  }

  // State-colored flags remain dynamic while the stone body comes from the atlas.
  if(lod!=="far"){
    ctx.save();ctx.strokeStyle='#4f3a28';ctx.lineWidth=2;
    for(const fx of [x-s*.28,x+s*.28]){
      ctx.beginPath();ctx.moveTo(fx,y-s*.26);ctx.lineTo(fx,y-s*.50);ctx.stroke();
      ctx.fillStyle=state.color||'#8d6840';fillPolygon(ctx,[[fx,y-s*.49],[fx+s*.17,y-s*.45],[fx,y-s*.38]],state.color||'#8d6840');
    }
    ctx.restore();
  }

  if(selected){ctx.save();ctx.strokeStyle='#f2cf75';ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.beginPath();ctx.ellipse(x,y+s*.06,s*.58,s*.47,0,0,Math.PI*2);ctx.stroke();ctx.restore();}
  if(clusterCount>1){ctx.save();ctx.fillStyle='#281f16';ctx.strokeStyle='#e6c46d';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x+s*.40,y-s*.40,13,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#fff0c6';ctx.font='800 9px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(`+${clusterCount-1}`,x+s*.40,y-s*.40+.5);ctx.restore();}
  ctx.restore();
}

function IslandMapInner({ snapshot, selected, onSelect, onAttack, onSwitchState, onExplore, onOpenBattle, onOpenIsland }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ width: 390, height: 620, dpr: 1 });
  const cameraRef = useRef<Camera>({ x: snapshot.state.worldX, y: snapshot.state.worldY, zoom: DEFAULT_ZOOM });
  const rafRef = useRef<number | null>(null);
  const terrainBufferRef = useRef<TerrainBufferCache | null>(null);
  const avatarCacheRef = useRef(new Map<string, HTMLImageElement>());
  const wheelRafRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelPointRef = useRef({ x: 0, y: 0 });
  const animationRef = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ id: number; x: number; y: number; camera: Camera; lastX: number; lastY: number; lastAt: number; vx: number; vy: number } | null>(null);
  const gestureRef = useRef({ moved: false, pinched: false });
  const pinchRef = useRef<{ distance: number; zoom: number; worldX: number; worldY: number } | null>(null);
  const exploreTimer = useRef<number | null>(null);
  const liveExploreAtRef = useRef(0);
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

  const constrainCamera = useCallback((camera: Camera) => clampCameraToWorld(camera, bounds, sizeRef.current.width, sizeRef.current.height), [bounds]);

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

  const drawBufferedTerrain = useCallback((ctx: CanvasRenderingContext2D, cam: Camera, width: number, height: number, dpr: number) => {
    const marginX = Math.max(90, width * .25);
    const marginY = Math.max(120, height * .25);
    const logicalW = width + marginX * 2;
    const logicalH = height + marginY * 2;
    const cacheDpr = Math.min(1.25, dpr);
    let cache = terrainBufferRef.current;

    // Reuse the buffered world while panning AND through modest zoom changes.
    // Sampling the correct source rectangle from the cached zoom keeps terrain
    // aligned with world coordinates without rebuilding gradients/forests on
    // every wheel or pinch frame.
    let srcW = cache ? width * cache.anchor.zoom / cam.zoom : width;
    let srcH = cache ? height * cache.anchor.zoom / cam.zoom : height;
    let srcX = cache ? cache.width / 2 + (cam.x - cache.anchor.x) * cache.anchor.zoom - srcW / 2 : marginX;
    let srcY = cache ? cache.height / 2 + (cam.y - cache.anchor.y) * cache.anchor.zoom - srcH / 2 : marginY;
    const zoomRatio = cache ? cam.zoom / cache.anchor.zoom : 1;
    const valid = Boolean(cache
      && Math.abs(cache.width - logicalW) < 2
      && Math.abs(cache.height - logicalH) < 2
      && Math.abs(cache.dpr - cacheDpr) < .01
      && zoomRatio >= .82
      && zoomRatio <= 1.22
      && srcX >= 2
      && srcY >= 2
      && srcX + srcW <= cache.width - 2
      && srcY + srcH <= cache.height - 2);

    if (!valid) {
      const canvas = cache?.canvas || document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(logicalW * cacheDpr));
      canvas.height = Math.max(1, Math.round(logicalH * cacheDpr));
      const bufferCtx = canvas.getContext("2d", { alpha: false });
      if (!bufferCtx) { drawWorldTerrain(ctx,cam,width,height); return; }
      bufferCtx.setTransform(cacheDpr,0,0,cacheDpr,0,0);
      bufferCtx.globalAlpha=1; bufferCtx.globalCompositeOperation="source-over";
      bufferCtx.clearRect(0,0,logicalW,logicalH);
      drawWorldTerrain(bufferCtx,cam,logicalW,logicalH);
      cache={canvas,anchor:{...cam},width:logicalW,height:logicalH,dpr:cacheDpr,marginX,marginY};
      terrainBufferRef.current=cache;
      srcW=width;
      srcH=height;
      srcX=cache.marginX;
      srcY=cache.marginY;
    }

    if (!cache) {
      drawWorldTerrain(ctx,cam,width,height);
      return;
    }

    ctx.drawImage(
      cache.canvas,
      srcX*cache.dpr,
      srcY*cache.dpr,
      srcW*cache.dpr,
      srcH*cache.dpr,
      0,
      0,
      width,
      height,
    );
  }, []);

  const draw = useCallback(() => {
    const canvas=canvasRef.current;
    if (!canvas) return;
    const {width,height,dpr}=sizeRef.current;
    const ctx=canvas.getContext("2d",{alpha:false});
    if (!ctx) return;
    const cam=constrainCamera(cameraRef.current);
    cameraRef.current=cam;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.globalAlpha=1;
    ctx.globalCompositeOperation="source-over";
    ctx.imageSmoothingEnabled=true;
    ctx.clearRect(0,0,width,height);
    try {
      drawBufferedTerrain(ctx,cam,width,height,dpr);
    } catch {
      terrainBufferRef.current=null;
      ctx.fillStyle="#4f7932";
      ctx.fillRect(0,0,width,height);
    }

    const worldToScreen=(x:number,y:number)=>({x:width/2+(x-cam.x)*cam.zoom,y:height/2+(y-cam.y)*cam.zoom});
    if (cam.zoom>=.43 && mine) {
      const a=worldToScreen(mine.worldX,mine.worldY);
      ctx.save(); ctx.strokeStyle="rgba(239,209,128,.54)"; ctx.lineWidth=1.5; ctx.setLineDash([8,8]);
      for(const ally of allied){ const b=worldToScreen(ally.worldX,ally.worldY); if((a.x< -50&&b.x< -50)||(a.x>width+50&&b.x>width+50)||(a.y< -50&&b.y< -50)||(a.y>height+50&&b.y>height+50)) continue; ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke(); }
      ctx.restore();
    }

    const items=buildRenderItems(visibleStates,cam,width,height,selected?.id);
    const currentLod=lodForZoom(cam.zoom);
    const extremeFar=cam.zoom<.16;
    for(const item of items){
      const state=item.state;
      const s=extremeFar ? 74 : markerSize(state,selected?.id);
      if(!extremeFar) drawCastle(ctx,item,currentLod,selected?.id);

      let avatar:HTMLImageElement|undefined;
      if(state.avatarUrl && typeof window!=="undefined") {
        avatar=avatarCacheRef.current.get(state.avatarUrl);
        if(!avatar){
          const cache=avatarCacheRef.current;
          // Keep decoded Telegram avatars bounded. Long map sessions can visit
          // hundreds of states; an unbounded HTMLImageElement cache eventually
          // pressures the WebView GPU/decoder and can contribute to black frames.
          if(cache.size>=160){
            let removed=0;
            for(const key of cache.keys()){
              cache.delete(key);
              removed+=1;
              if(removed>=32) break;
            }
          }
          const image=new window.Image(); image.decoding="async"; image.src=state.avatarUrl;
          image.onload=()=>{ if(rafRef.current==null) rafRef.current=window.requestAnimationFrame(()=>{rafRef.current=null;draw();}); };
          image.onerror=()=>{ cache.delete(state.avatarUrl!); };
          cache.set(state.avatarUrl,image); avatar=image;
        }
      }
      drawShield(ctx,item.x,item.y-(extremeFar?0:s*.43),extremeFar?34:(currentLod==="far"?26:30),state.color||"#7d6342",crestText(state),avatar);

      if(extremeFar && item.clusterCount>1){ctx.save();ctx.fillStyle="#281f16";ctx.strokeStyle="#e6c46d";ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(item.x+25,item.y-22,11,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle="#fff0c6";ctx.font="800 8px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(`+${item.clusterCount-1}`,item.x+25,item.y-21.5);ctx.restore();}

      if(extremeFar || currentLod!=="far" || state.isMine || state.id===selected?.id){
        const labelY=extremeFar?item.y+25:item.y+s*.62;
        ctx.save();
        ctx.font=`800 ${extremeFar?10:currentLod==="near"?13:11}px Georgia, serif`;
        const title=displayName(state);
        const handle=state.stateUsername ? `@${state.stateUsername}` : "юз не создан";
        const measured=ctx.measureText(title).width;
        const textW=Math.min(extremeFar?170:230,Math.max(extremeFar?94:118,measured+24));
        const h=extremeFar?27:currentLod==="near"?41:36;
        ctx.fillStyle="rgba(24,20,14,.94)"; roundRect(ctx,item.x-textW/2,labelY,textW,h,extremeFar?7:9);ctx.fill();
        ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#f4e8c9";ctx.fillText(title,item.x,labelY+(extremeFar?13:11),Math.max(20,textW-16));
        if(!extremeFar){ctx.font="700 8px system-ui";ctx.fillStyle="#c6ad77";ctx.fillText(handle,item.x,labelY+25,Math.max(20,textW-16));}
        ctx.restore();
      }
    }
  }, [allied,constrainCamera,drawBufferedTerrain,mine,selected?.id,visibleStates]);

  const requestDraw = useCallback(() => {
    if(rafRef.current!=null) return;
    rafRef.current=window.requestAnimationFrame(()=>{
      rafRef.current=null;
      try {
        draw();
      } catch {
        terrainBufferRef.current=null;
        const canvas=canvasRef.current;
        if(canvas){
          const {width,height,dpr}=sizeRef.current;
          const ctx=canvas.getContext("2d",{alpha:false});
          if(ctx){
            ctx.setTransform(dpr,0,0,dpr,0,0);
            ctx.globalAlpha=1;
            ctx.globalCompositeOperation="source-over";
            ctx.fillStyle="#4f7932";
            ctx.fillRect(0,0,width,height);
          }
        }
      }
    });
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

  const exploreDuringMotion = useCallback((camera: Camera) => {
    if (!onExplore) return;
    const at = performance.now();
    if (at - liveExploreAtRef.current < 420) return;
    liveExploreAtRef.current = at;
    onExplore(camera.x, camera.y, Math.min(9000, Math.max(2600, 3400 / camera.zoom)));
  }, [onExplore]);

  const animateCameraTo = useCallback((target:Camera,duration=260,explore=true) => {
    stopAnimation();
    const from=constrainCamera({...cameraRef.current});
    const safeTarget=constrainCamera(target);
    const started=performance.now();
    const frame=(at:number)=>{
      const t=clamp((at-started)/duration,0,1);
      const eased=1-Math.pow(1-t,3);
      cameraRef.current=constrainCamera({x:from.x+(safeTarget.x-from.x)*eased,y:from.y+(safeTarget.y-from.y)*eased,zoom:from.zoom+(safeTarget.zoom-from.zoom)*eased});
      updateLod(cameraRef.current.zoom);requestDraw();
      if(t<1) animationRef.current=window.requestAnimationFrame(frame);
      else{animationRef.current=null;persistAndExplore(cameraRef.current,explore);}
    };
    animationRef.current=window.requestAnimationFrame(frame);
  }, [constrainCamera,persistAndExplore,requestDraw,stopAnimation,updateLod]);

  const startInertia = useCallback((vx:number,vy:number) => {
    stopAnimation();
    vx=clamp(vx,-3.6,3.6); vy=clamp(vy,-3.6,3.6);
    const started=performance.now();
    let previous=started;
    const frame=(at:number)=>{
      const dt=Math.min(32,at-previous); previous=at;
      const elapsed=at-started;
      const decay=Math.pow(.875,dt/16.67);
      vx*=decay; vy*=decay;
      if(elapsed>620||Math.hypot(vx,vy)<.012){animationRef.current=null;persistAndExplore(cameraRef.current,true);return;}
      const before=cameraRef.current;
      const next=constrainCamera({...before,x:before.x+vx*dt,y:before.y+vy*dt});
      if (Math.abs(next.x-before.x)<.001) vx*=.15;
      if (Math.abs(next.y-before.y)<.001) vy*=.15;
      cameraRef.current=next;
      exploreDuringMotion(next);
      requestDraw(); animationRef.current=window.requestAnimationFrame(frame);
    };
    animationRef.current=window.requestAnimationFrame(frame);
  }, [constrainCamera,exploreDuringMotion,persistAndExplore,requestDraw,stopAnimation]);

  useEffect(()=>{
    const el=viewportRef.current,canvas=canvasRef.current;if(!el||!canvas)return;
    const update=()=>{const width=el.clientWidth||390,height=el.clientHeight||620,dpr=Math.min(1.6,window.devicePixelRatio||1);sizeRef.current={width,height,dpr};canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;cameraRef.current=clampCameraToWorld(cameraRef.current,bounds,width,height);terrainBufferRef.current=null;requestDraw();};
    const lost=(event:Event)=>{event.preventDefault();terrainBufferRef.current=null;};
    const restore=()=>{terrainBufferRef.current=null;update();};
    const pageShow=()=>{terrainBufferRef.current=null;requestDraw();};
    const visibility=()=>{if(document.visibilityState==="visible"){terrainBufferRef.current=null;requestDraw();}};
    update();
    const delayed=window.setTimeout(requestDraw,120);
    const observer=new ResizeObserver(update);observer.observe(el);
    canvas.addEventListener("contextlost",lost);canvas.addEventListener("contextrestored",restore);
    window.addEventListener("pageshow",pageShow);document.addEventListener("visibilitychange",visibility);
    return()=>{window.clearTimeout(delayed);observer.disconnect();canvas.removeEventListener("contextlost",lost);canvas.removeEventListener("contextrestored",restore);window.removeEventListener("pageshow",pageShow);document.removeEventListener("visibilitychange",visibility);if(wheelRafRef.current!=null){window.cancelAnimationFrame(wheelRafRef.current);wheelRafRef.current=null;}};
  },[bounds,requestDraw]);

  useEffect(()=>{requestDraw();},[requestDraw,snapshot.islands,selected?.id,filter]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30_000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{
    try{const stored=window.sessionStorage.getItem("warstate-map-camera-v7")||window.sessionStorage.getItem("warstate-map-camera-v6");if(stored){const parsed=JSON.parse(stored) as Camera;if(Number.isFinite(parsed.x)&&Number.isFinite(parsed.y)&&Number.isFinite(parsed.zoom))cameraRef.current=constrainCamera({x:parsed.x,y:parsed.y,zoom:clamp(parsed.zoom,MIN_ZOOM,MAX_ZOOM)});}}catch{/* optional */}
    cameraRef.current=constrainCamera(cameraRef.current); updateLod(cameraRef.current.zoom);requestDraw();
    return()=>{if(rafRef.current!=null)window.cancelAnimationFrame(rafRef.current);stopAnimation();if(exploreTimer.current!=null)window.clearTimeout(exploreTimer.current);avatarCacheRef.current.clear();terrainBufferRef.current=null;};
  },[constrainCamera,requestDraw,stopAnimation,updateLod]);

  const localPoint=useCallback((event:ReactPointerEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return{x:event.clientX-rect.left,y:event.clientY-rect.top};},[]);

  const findStateAt=useCallback((screenX:number,screenY:number)=>{
    const items=buildRenderItems(visibleStates,cameraRef.current,sizeRef.current.width,sizeRef.current.height,selected?.id);
    let best:IslandView|null=null,bestDist=Infinity;
    for(const item of items){const d=Math.hypot(item.x-screenX,item.y-screenY);const hit=(cameraRef.current.zoom<.16?34:markerSize(item.state,selected?.id)*.48);if(d<hit&&d<bestDist){best=item.state;bestDist=d;}}
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
    if(pointers.current.size>=2&&pinchRef.current){const[a,b]=[...pointers.current.values()];const midX=(a.x+b.x)/2,midY=(a.y+b.y)/2,distance=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),pinch=pinchRef.current,zoom=clamp(pinch.zoom*distance/pinch.distance,MIN_ZOOM,MAX_ZOOM);cameraRef.current=constrainCamera({x:pinch.worldX-(midX-sizeRef.current.width/2)/zoom,y:pinch.worldY-(midY-sizeRef.current.height/2)/zoom,zoom});updateLod(cameraRef.current.zoom);exploreDuringMotion(cameraRef.current);requestDraw();return;}
    const drag=dragRef.current;if(!drag||drag.id!==event.pointerId)return;
    const threshold=event.pointerType==="touch"?CLICK_THRESHOLD_TOUCH:CLICK_THRESHOLD_MOUSE;if(Math.hypot(point.x-drag.x,point.y-drag.y)>threshold)gestureRef.current.moved=true;
    const at=performance.now(),dt=Math.max(1,at-drag.lastAt),dx=point.x-drag.lastX,dy=point.y-drag.lastY;
    drag.vx=clamp(drag.vx*.68+(-dx/drag.camera.zoom/dt)*.32,-3.8,3.8);drag.vy=clamp(drag.vy*.68+(-dy/drag.camera.zoom/dt)*.32,-3.8,3.8);drag.lastX=point.x;drag.lastY=point.y;drag.lastAt=at;
    cameraRef.current=constrainCamera({...drag.camera,x:drag.camera.x-(point.x-drag.x)/drag.camera.zoom,y:drag.camera.y-(point.y-drag.y)/drag.camera.zoom});exploreDuringMotion(cameraRef.current);requestDraw();
  },[constrainCamera,exploreDuringMotion,localPoint,requestDraw,updateLod]);

  const finishPointer=useCallback((event:ReactPointerEvent<HTMLDivElement>,cancelled=false)=>{
    const point=pointers.current.get(event.pointerId);const drag=dragRef.current;pointers.current.delete(event.pointerId);
    if(pointers.current.size<2)pinchRef.current=null;
    if(pointers.current.size===1){const[id,p]=[...pointers.current.entries()][0];dragRef.current={id,x:p.x,y:p.y,camera:{...cameraRef.current},lastX:p.x,lastY:p.y,lastAt:performance.now(),vx:0,vy:0};return;}
    dragRef.current=null;
    // A short pinch can finish before the live-explore throttle fires. Persist
    // and fetch once at the final zoom so the new viewport never waits for a
    // second gesture before loading its buffered states.
    persistAndExplore(cameraRef.current,!cancelled&&gestureRef.current.pinched);
    if(cancelled||gestureRef.current.pinched)return;
    if(point&&drag&&!gestureRef.current.moved){const state=findStateAt(point.x,point.y);onSelect(state||null);return;}
    if(drag&&gestureRef.current.moved)startInertia(drag.vx,drag.vy);
  },[findStateAt,onSelect,persistAndExplore,startInertia]);

  const zoomAt=useCallback((nextZoom:number,screenX=sizeRef.current.width/2,screenY=sizeRef.current.height/2,animated=false)=>{
    const current=cameraRef.current,zoom=clamp(nextZoom,MIN_ZOOM,MAX_ZOOM),worldX=current.x+(screenX-sizeRef.current.width/2)/current.zoom,worldY=current.y+(screenY-sizeRef.current.height/2)/current.zoom,target={x:worldX-(screenX-sizeRef.current.width/2)/zoom,y:worldY-(screenY-sizeRef.current.height/2)/zoom,zoom};
    const safeTarget=constrainCamera(target);
    if(animated){animateCameraTo(safeTarget,180,true);return;}cameraRef.current=safeTarget;updateLod(safeTarget.zoom);requestDraw();persistAndExplore(safeTarget,true);
  },[animateCameraTo,constrainCamera,persistAndExplore,requestDraw,updateLod]);

  const wheel=useCallback((event:ReactWheelEvent<HTMLDivElement>)=>{
    event.preventDefault(); stopAnimation();
    const rect=event.currentTarget.getBoundingClientRect();
    wheelDeltaRef.current+=event.deltaY; wheelPointRef.current={x:event.clientX-rect.left,y:event.clientY-rect.top};
    if(wheelRafRef.current!=null) return;
    wheelRafRef.current=window.requestAnimationFrame(()=>{
      wheelRafRef.current=null;
      const delta=wheelDeltaRef.current; wheelDeltaRef.current=0;
      const factor=Math.exp(-delta*.00135);
      zoomAt(cameraRef.current.zoom*factor,wheelPointRef.current.x,wheelPointRef.current.y,false);
    });
  },[stopAnimation,zoomAt]);
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
