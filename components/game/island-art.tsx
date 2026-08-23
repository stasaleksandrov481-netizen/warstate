"use client";

import { memo, useMemo } from "react";

type Props = {
  id: string;
  members: number;
  color: string;
  integrity: number;
  ruined?: boolean;
  selected?: boolean;
  detail?: "far" | "mid" | "near";
  freeport?: boolean;
  fullCity?: boolean;
};

type Pt = { x: number; y: number };

function hash(input: string) {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value >>> 0);
}

function rand(seed: number, index: number) {
  let x = (seed + index * 0x9e3779b1) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967295;
}

function smoothClosedPath(points: Pt[]) {
  if (!points.length) return "";
  const n = points.length;
  const first = points[0];
  let d = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < n; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % n];
    const mx = (current.x + next.x) / 2;
    const my = (current.y + next.y) / 2;
    d += ` Q ${current.x.toFixed(1)} ${current.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  d += " Z";
  return d;
}

function generateIsland(seed: number, members: number, freeport: boolean) {
  const count = freeport ? 34 : 28;
  const cx = 160;
  const cy = 111;
  // The coastline itself expands with the real Telegram population. The outer
  // world node also grows, so crowded communities gain actual screen/world
  // area instead of packing houses on top of each other.
  const population = Math.max(1, members);
  const growth = Math.min(1, Math.log10(population + 1) / 4.35);
  const rx = freeport ? 137 : 88 + growth * 46;
  const ry = freeport ? 80 : 53 + growth * 30;
  const coast: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const continental = Math.sin(angle * 2 + (seed % 23) * .11) * .028;
    const coves = Math.sin(angle * 4 + (seed % 37) * .07) * .043;
    const detail = Math.sin(angle * 7 + (seed % 17) * .13) * .018;
    const noise = (rand(seed, i) - 0.5) * 0.10;
    const radius = 1 + continental + coves + detail + noise;
    coast.push({ x: cx + Math.cos(angle) * rx * radius, y: cy + Math.sin(angle) * ry * radius });
  }
  const land = coast.map((point) => ({ x: cx + (point.x - cx) * 0.87, y: cy + (point.y - cy) * 0.83 }));
  return {
    coastPath: smoothClosedPath(coast),
    landPath: smoothClosedPath(land),
    cx,
    cy,
    rx: rx * 0.84,
    ry: ry * 0.79,
  };
}

function homeGeometry(seed: number, members: number, detail: "far" | "mid" | "near", rx: number, ry: number, freeport: boolean, fullCity: boolean) {
  if (detail === "far" || members <= 0) return { walls: "", roofsA: "", roofsB: "", rendered: 0, overflow: 0 };

  // Every Telegram member has a deterministic lot index. At close zoom we draw
  // thousands of individual houses as three compound paths (not React nodes).
  // Very large groups use visual LOD, but the underlying lot assignment
  // stays stable, so zooming in reveals the same city rather than a new random
  // layout.
  const renderLimit = detail === "near" ? (fullCity ? 6_000 : 3_600) : 760;
  const requested = Math.min(Math.max(0, Math.floor(members)), renderLimit);
  const overflow = Math.max(0, members - requested);
  const cx = 160;
  const cy = 111;

  type Lot = { x: number; y: number; score: number };
  const civicZones: Array<{ x: number; y: number; radius: number }> = [
    { x: 160, y: 104, radius: 18 },
    ...(freeport || members >= 40 ? [{ x: 205, y: 115, radius: 12 }] : []),
    ...(freeport || members >= 90 ? [{ x: 111, y: 117, radius: 15 }] : []),
    ...(freeport || members >= 180 ? [{ x: 188, y: 80, radius: 13 }] : []),
    ...(freeport || members >= 350 ? [{ x: 132, y: 74, radius: 15 }] : []),
    ...(freeport || members >= 700 ? [{ x: 224, y: 93, radius: 11 }] : []),
    ...(freeport || members >= 1200 ? [{ x: 93, y: 87, radius: 17 }] : []),
    ...(freeport || members >= 2500 ? [{ x: 202, y: 137, radius: 19 }] : []),
    ...(freeport || members >= 5000 ? [{ x: 126, y: 142, radius: 18 }] : []),
  ];
  const validLot = (x: number, y: number, spacing: number) => {
    const nx = (x - cx) / (rx * 0.80);
    const ny = (y - cy) / (ry * 0.76);
    if (nx * nx + ny * ny > 1) return null;

    // Civic plaza and port boulevard are hard no-build zones. Keeping these
    // holes in the lot generator guarantees houses cannot overlap HQ/port.
    const plaza = ((x - cx) / Math.max(12, rx * 0.25)) ** 2 + ((y - (cy - 2)) / Math.max(9, ry * 0.27)) ** 2;
    if (plaza < 1) return null;
    if (y > cy + ry * 0.54 && Math.abs(x - cx) < rx * 0.32) return null;
    if (civicZones.some((zone) => Math.hypot(x - zone.x, y - zone.y) < zone.radius + spacing * 0.34)) return null;
    return { nx, ny };
  };

  const visitLots = (spacing: number, collect: boolean) => {
    const lots: Lot[] = [];
    let count = 0;
    const dx = spacing;
    const dy = spacing * 0.86;
    let row = 0;
    for (let y = cy - ry * 0.72; y <= cy + ry * 0.68; y += dy, row += 1) {
      const offset = row % 2 ? dx * 0.5 : 0;
      for (let x = cx - rx * 0.79 + offset; x <= cx + rx * 0.79; x += dx) {
        const valid = validLot(x, y, spacing);
        if (!valid) continue;
        count += 1;
        if (!collect) continue;
        const key = Math.floor(x * 13) ^ (Math.floor(y * 17) << 1);
        const radius = Math.hypot(valid.nx, valid.ny);
        lots.push({ x, y, score: radius + rand(seed ^ 0x7f4a7c15, key) * 0.10 });
      }
    }
    if (collect) lots.sort((a, b) => a.score - b.score);
    return { count, lots };
  };

  // Spacing is the collision rule. Capacity checks intentionally do not build
  // or sort arrays, which keeps large 10k–50k cities from freezing the UI.
  let spacing = Math.max(0.34, Math.min(8.5, Math.sqrt((rx * ry * 1.62) / Math.max(1, requested))));
  let capacity = visitLots(spacing, false).count;
  for (let pass = 0; capacity < requested && pass < 12; pass += 1) {
    const next = Math.max(0.30, spacing * 0.91);
    if (next === spacing) break;
    spacing = next;
    capacity = visitLots(spacing, false).count;
  }
  const lots = visitLots(spacing, true).lots;

  const walls: string[] = [];
  const roofsA: string[] = [];
  const roofsB: string[] = [];
  const count = Math.min(requested, lots.length);
  const w = spacing * 0.46;
  const h = spacing * 0.34;
  for (let i = 0; i < count; i += 1) {
    const lot = lots[i];
    const jitter = Math.min(spacing * 0.035, 0.16);
    const x = lot.x + (rand(seed ^ 0x51f15e, i * 2) - 0.5) * jitter;
    const y = lot.y + (rand(seed ^ 0x2af31c, i * 2 + 1) - 0.5) * jitter;
    walls.push(`M${(x-w/2).toFixed(2)} ${(y-h/2).toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h-${w.toFixed(2)}Z`);
    const roof = `M${(x-w*0.60).toFixed(2)} ${(y-h/2).toFixed(2)}L${x.toFixed(2)} ${(y-h*1.12).toFixed(2)}L${(x+w*0.60).toFixed(2)} ${(y-h/2).toFixed(2)}Z`;
    (i % 5 === 0 ? roofsB : roofsA).push(roof);
  }

  return {
    walls: walls.join(""),
    roofsA: roofsA.join(""),
    roofsB: roofsB.join(""),
    rendered: count,
    overflow: overflow + Math.max(0, requested - count),
  };
}

function roadGeometry(seed: number, rx: number, ry: number, members: number) {
  const paths: string[] = [];
  const spokes = members >= 1600 ? 6 : members >= 450 ? 5 : members >= 80 ? 4 : 3;
  paths.push(`M${(160-rx*.24).toFixed(1)} 111a${(rx*.24).toFixed(1)} ${(ry*.22).toFixed(1)} 0 1 0 ${(rx*.48).toFixed(1)} 0a${(rx*.24).toFixed(1)} ${(ry*.22).toFixed(1)} 0 1 0 -${(rx*.48).toFixed(1)} 0`);
  for (let i = 0; i < spokes; i += 1) {
    const phase = rand(seed ^ 0x1f83d9ab, i) * 0.34;
    const angle = ((i + phase) / spokes) * Math.PI * 2;
    const ex = 160 + Math.cos(angle) * rx * (0.63 + rand(seed, i + 51) * 0.10);
    const ey = 111 + Math.sin(angle) * ry * (0.58 + rand(seed, i + 77) * 0.10);
    const bend = (rand(seed ^ 0x5be0cd19, i) - 0.5) * 16;
    const mx = 160 + Math.cos(angle + 0.42) * bend;
    const my = 111 + Math.sin(angle + 0.42) * bend * 0.55;
    paths.push(`M160 111Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
  }
  return paths.join("");
}

const MAP_HOME_CACHE = new Map<string, ReturnType<typeof homeGeometry>>();
const FULL_HOME_CACHE = new Map<string, ReturnType<typeof homeGeometry>>();

function cachedHomeGeometry(seed: number, members: number, detail: "far" | "mid" | "near", rx: number, ry: number, freeport: boolean, fullCity: boolean) {
  const cache = fullCity ? FULL_HOME_CACHE : MAP_HOME_CACHE;
  const key = `${seed}:${members}:${detail}:${rx.toFixed(2)}:${ry.toFixed(2)}:${freeport ? 1 : 0}:${fullCity ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const geometry = homeGeometry(seed, members, detail, rx, ry, freeport, fullCity);
  cache.set(key, geometry);
  const max = fullCity ? 2 : 48;
  while (cache.size > max) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return geometry;
}

function circlePath(x: number, y: number, r: number) {
  return `M${(x-r).toFixed(1)} ${y.toFixed(1)}a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(r*2).toFixed(1)} 0a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 -${(r*2).toFixed(1)} 0`;
}

function treeGeometry(seed: number, count: number, rx: number, ry: number) {
  const trunks: string[] = [];
  const crownsA: string[] = [];
  const crownsB: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = rand(seed, i * 3 + 1) * Math.PI * 2;
    const radial = 0.84 + rand(seed, i * 3 + 2) * 0.12;
    const x = 160 + Math.cos(angle) * rx * radial;
    const y = 111 + Math.sin(angle) * ry * radial;
    const r = 1.8 + rand(seed, i * 3 + 3) * 2.2;
    trunks.push(`M${(x-.65).toFixed(1)} ${y.toFixed(1)}h1.3v${(r*1.75).toFixed(1)}h-1.3Z`);
    (i % 4 === 0 ? crownsB : crownsA).push(circlePath(x, y, r));
  }
  return { trunks: trunks.join(""), crownsA: crownsA.join(""), crownsB: crownsB.join("") };
}

function detailGeometry(seed: number, rx: number, ry: number, members: number) {
  const rocks: string[] = [];
  const shrubs: string[] = [];
  const fieldRows: string[] = [];
  const rockCount = members > 1500 ? 16 : members > 200 ? 12 : 8;
  for (let i = 0; i < rockCount; i += 1) {
    const a = rand(seed ^ 0x6a09e667, i) * Math.PI * 2;
    const radial = 0.77 + rand(seed ^ 0xbb67ae85, i) * 0.10;
    const x = 160 + Math.cos(a) * rx * radial;
    const y = 111 + Math.sin(a) * ry * radial;
    const r = 0.8 + rand(seed ^ 0x3c6ef372, i) * 1.25;
    rocks.push(circlePath(x, y, r));
  }
  for (let i = 0; i < 9; i += 1) {
    const a = rand(seed ^ 0xa54ff53a, i) * Math.PI * 2;
    const radial = 0.48 + rand(seed ^ 0x510e527f, i) * 0.20;
    const x = 160 + Math.cos(a) * rx * radial;
    const y = 111 + Math.sin(a) * ry * radial;
    shrubs.push(circlePath(x, y, 0.8 + rand(seed, i + 90) * 0.9));
  }
  if (members >= 120) {
    const x0 = 160 - rx * 0.48;
    const y0 = 111 + ry * 0.22;
    const width = Math.max(18, rx * 0.25);
    for (let i = 0; i < 5; i += 1) {
      const y = y0 + i * 2.1;
      fieldRows.push(`M${x0.toFixed(1)} ${y.toFixed(1)}q${(width*.5).toFixed(1)} -1.4 ${width.toFixed(1)} 0`);
    }
  }
  return { rocks: rocks.join(""), shrubs: shrubs.join(""), fieldRows: fieldRows.join("") };
}

function IslandArtInner({ id, members, color, integrity, ruined = false, selected = false, detail = "near", freeport = false, fullCity = false }: Props) {
  const seed = useMemo(() => hash(id), [id]);
  const geo = useMemo(() => generateIsland(seed, members, freeport), [seed, members, freeport]);
  const homes = useMemo(() => cachedHomeGeometry(seed, members, detail, geo.rx, geo.ry, freeport, fullCity), [seed, members, detail, geo.rx, geo.ry, freeport, fullCity]);
  const trees = useMemo(() => treeGeometry(seed, detail === "far" ? 5 : detail === "mid" ? 12 : 22, geo.rx, geo.ry), [seed, detail, geo.rx, geo.ry]);
  const details = useMemo(() => detailGeometry(seed, geo.rx, geo.ry, members), [seed, geo.rx, geo.ry, members]);
  const roads = useMemo(() => roadGeometry(seed, geo.rx, geo.ry, members), [seed, geo.rx, geo.ry, members]);
  const damage = Math.max(0, Math.min(1, (100 - integrity) / 100));

  return (
    <svg className={`island-art procedural ${freeport ? "freeport" : ""} ${ruined ? "ruined" : ""} ${selected ? "selected" : ""}`} viewBox="0 0 320 220" role="img" aria-hidden="true" data-homes={members}>
      <defs>
        <linearGradient id={`sand-${seed}`} x1="0" y1="0" x2=".8" y2="1">
          <stop offset="0" stopColor="#ffe5a0" />
          <stop offset=".52" stopColor="#e7bb69" />
          <stop offset="1" stopColor="#a96f3b" />
        </linearGradient>
        <linearGradient id={`grass-${seed}`} x1=".15" y1="0" x2=".85" y2="1">
          <stop offset="0" stopColor={ruined ? "#86806d" : freeport ? "#8acb63" : "#75c451"} />
          <stop offset=".55" stopColor={ruined ? "#595a4a" : "#45973d"} />
          <stop offset="1" stopColor={ruined ? "#33382f" : "#236735"} />
        </linearGradient>
        <clipPath id={`land-${seed}`}><path d={geo.landPath} /></clipPath>
      </defs>

      <ellipse cx="160" cy="160" rx={freeport ? 116 : 92} ry={freeport ? 22 : 18} fill="#063a49" opacity=".22" />
      <path d={geo.coastPath} fill="none" stroke="#6ed5d3" strokeWidth="18" opacity={ruined ? .2 : .34} />
      <path className="island-foam-soft" d={geo.coastPath} fill="none" stroke="#d9fff4" strokeWidth="8" opacity={ruined ? .3 : .66} />
      <path className="island-foam" d={geo.coastPath} fill="none" stroke="#fffdf0" strokeWidth="3.2" strokeLinecap="round" strokeDasharray="12 6 3 7" opacity={ruined ? .42 : .96} />
      <path d={geo.coastPath} fill={`url(#sand-${seed})`} />
      <path d={geo.landPath} fill={`url(#grass-${seed})`} />

      <g clipPath={`url(#land-${seed})`}>
        {detail !== "far" && (
          <g className="island-roads" fill="none" stroke="#e2cf96" strokeLinecap="round" opacity={ruined ? .25 : .58}>
            <path d={roads} strokeWidth="1.8" strokeDasharray="3 3" />
          </g>
        )}

        <g opacity={ruined ? .25 : .9}>
          {trees.trunks && <path d={trees.trunks} fill="#704a2d" />}
          {trees.crownsA && <path d={trees.crownsA} fill="#347b38" />}
          {trees.crownsB && <path d={trees.crownsB} fill="#65a841" />}
        </g>

        {detail === "near" && (
          <g className="island-micro-details" opacity={ruined ? .25 : .82}>
            {details.rocks && <path d={details.rocks} fill="#786d57" opacity=".78" />}
            {details.shrubs && <path d={details.shrubs} fill="#2e7138" />}
            {details.fieldRows && <path d={details.fieldRows} fill="none" stroke="#cfbd75" strokeWidth="1" strokeLinecap="round" opacity=".72" />}
          </g>
        )}

        {homes.walls && <path d={homes.walls} fill={ruined ? "#9b8f79" : "#f1d9a5"} stroke="#6b5943" strokeWidth=".35" opacity={detail === "mid" ? .78 : .96} />}
        {homes.roofsA && <path d={homes.roofsA} fill={ruined ? "#665d58" : color} stroke="#51434a" strokeWidth=".3" opacity={detail === "mid" ? .8 : .98} />}
        {homes.roofsB && <path d={homes.roofsB} fill={ruined ? "#6e5e53" : "#ca6d49"} stroke="#51434a" strokeWidth=".3" opacity={detail === "mid" ? .8 : .98} />}
        {homes.overflow > 0 && detail === "near" && (
          <g className="island-density-marker" transform="translate(160 146)" opacity={ruined ? .28 : .75}>
            <rect x="-22" y="-5" width="44" height="10" rx="5" fill="#f7e8b8" stroke="#735f3f" strokeWidth="1" />
            <text x="0" y="2.6" textAnchor="middle" fontSize="5" fontWeight="900" fill="#5b4a32">+{homes.overflow.toLocaleString("ru-RU")} домов · районы</text>
          </g>
        )}

        {/* Civic structures: not tied to members, but unlock as the community grows. */}
        <g className="island-civic" opacity={ruined ? .55 : 1}>
          <g transform="translate(160 104)">
            <rect x="-11" y="-5" width="22" height="17" rx="2" fill={freeport ? "#f0d49a" : "#e8cf9c"} stroke="#5e4e3a" strokeWidth="1" />
            <polygon points="-14,-5 0,-17 14,-5" fill={freeport ? "#dca94d" : color} stroke="#54414a" strokeWidth="1" />
            <rect x="-2.5" y="3" width="5" height="9" rx="1" fill="#594435" />
          </g>
          {(freeport || members >= 40) && <g transform="translate(205 115)"><rect x="-5" y="-12" width="10" height="18" rx="2" fill="#e5c985"/><polygon points="-8,-12 0,-21 8,-12" fill="#b56544"/><circle cy="-5" r="2" fill="#8bd1e4"/></g>}
          {(freeport || members >= 90) && <g transform="translate(111 117)"><rect x="-9" y="-4" width="18" height="10" rx="2" fill="#c99154"/><path d="M-11 -4h22L8 -12H-8Z" fill="#78513b"/><rect x="-2" y="-1" width="4" height="7" fill="#4d3c31"/></g>}
          {(freeport || members >= 180) && <g transform="translate(188 80)"><circle cy="0" r="8" fill="#d5bf78"/><path d="M0-20 7 0H-7Z" fill="#f0e5bd"/><rect x="-2" y="-24" width="4" height="28" fill="#765840"/></g>}
          {(freeport || members >= 350) && <g transform="translate(132 74)"><rect x="-10" y="-7" width="20" height="14" rx="3" fill="#9c754d"/><rect x="-6" y="-12" width="12" height="5" fill="#caa56d"/><path d="M-13-7H13L7-17H-7Z" fill="#6e5b47"/></g>}
          {(freeport || members >= 700) && <g transform="translate(224 93)"><rect x="-4" y="-18" width="8" height="24" fill="#f3dfad"/><path d="M-7-18H7L0-28Z" fill="#d35d45"/><circle cy="-13" r="2.5" fill="#fff4ae"/></g>}
          {(freeport || members >= 1200) && <g transform="translate(93 87)"><rect x="-13" y="-7" width="26" height="14" rx="2" fill="#b9854d"/><path d="M-15-7H15L9-14H-9Z" fill="#6c4b34"/><path d="M-8 0h4m4 0h4m4 0h4" stroke="#f0d68c" strokeWidth="2"/></g>}
          {(freeport || members >= 2500) && <g transform="translate(202 137)"><ellipse rx="16" ry="9" fill="#c59d5b" stroke="#5d4a36"/><ellipse rx="10" ry="5" fill="#6fa976"/><circle r="3" fill="#e9d374"/></g>}
          {(freeport || members >= 5000) && <g transform="translate(126 142)"><rect x="-13" y="-8" width="26" height="16" rx="4" fill="#d8c28a"/><path d="M-16-8H16L8-17H-8Z" fill="#8f5d43"/><circle cy="0" r="4" fill="#5b886c"/></g>}
        </g>
      </g>

      {/* Port is intentionally allowed to touch water, unlike houses. */}
      <g className="island-port" transform={freeport ? "translate(160 174) scale(1.15)" : "translate(160 166)"} opacity={ruined ? .38 : 1}>
        <path d="M-33 0H30" stroke="#815733" strokeWidth="5" strokeLinecap="round" />
        <path d="M-24 0v13M-8 0v16M10 0v15M26 0v11" stroke="#644326" strokeWidth="2.4" />
        <path d="M38 7 q13 -6 25 0 l-6 8h-14Z" fill="#9e6540" stroke="#573f31" strokeWidth="1" />
        <path d="M50 5v-14l9 7-9 3Z" fill={color} />
      </g>

      {freeport && detail !== "far" && (
        <g className="freeport-ring" fill="none" stroke="#f5df9a" opacity=".75">
          <path d="M38 165 C78 193 245 196 284 153" strokeWidth="2" strokeDasharray="6 6" />
          <circle cx="160" cy="111" r="46" strokeWidth="1.5" strokeDasharray="3 5" />
        </g>
      )}

      {damage > .15 && <path d="M111 91 128 104 118 121 140 132" fill="none" stroke="#342f2b" strokeWidth={2 + damage * 3} opacity={.25 + damage * .55} />}
      {ruined && (
        <g className="island-ruin-smoke">
          <circle cx="133" cy="76" r="9" fill="#342e2a" opacity=".52" />
          <circle cx="141" cy="62" r="12" fill="#51483d" opacity=".36" />
          <circle cx="149" cy="46" r="16" fill="#61594e" opacity=".22" />
        </g>
      )}
    </svg>
  );
}

export const IslandArt = memo(IslandArtInner);
