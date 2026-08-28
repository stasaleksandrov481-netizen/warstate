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
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return (x >>> 0) / 4294967295;
}

function CastleRegionArt({ id, members, color, integrity, ruined = false, selected = false, detail = "near", freeport = false }: Props) {
  const seed = useMemo(() => hash(id), [id]);
  const towers = members > 1200 ? 5 : members > 300 ? 4 : 3;
  const damage = Math.max(0, Math.min(1, (100 - integrity) / 100));
  const trees = useMemo(() => Array.from({ length: detail === "near" ? 18 : detail === "mid" ? 9 : 4 }, (_, i) => ({
    x: 52 + rand(seed, i * 3) * 216,
    y: 70 + rand(seed, i * 3 + 1) * 96,
    r: 3 + rand(seed, i * 3 + 2) * 4,
  })), [seed, detail]);

  return (
    <svg className={`island-art castle-region ${freeport ? "freeport" : ""} ${ruined ? "ruined" : ""} ${selected ? "selected" : ""}`} viewBox="0 0 320 220" role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`ground-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={freeport ? "#526048" : "#3f543d"}/>
          <stop offset="1" stopColor="#263729"/>
        </linearGradient>
        <linearGradient id={`stone-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={ruined ? "#6d675f" : "#8a877f"}/>
          <stop offset="1" stopColor={ruined ? "#49443f" : "#5d5a54"}/>
        </linearGradient>
      </defs>

      <path d="M35 82 79 43 144 36 205 47 281 84 267 157 220 184 135 190 58 166Z" fill={`url(#ground-${seed})`} stroke="#7a6741" strokeWidth={selected ? 5 : 3}/>
      <path d="M45 88 83 53 145 46 201 56 270 89 257 149 215 173 137 179 68 157Z" fill="none" stroke="#2a3028" strokeWidth="2" strokeDasharray="7 5" opacity=".75"/>
      {trees.map((tree, i) => <g key={i} opacity={ruined ? .35 : .9}><rect x={tree.x-1} y={tree.y} width="2" height="8" fill="#4b3829"/><circle cx={tree.x} cy={tree.y} r={tree.r} fill={i%2 ? "#314a32" : "#3d5c38"}/></g>)}

      {detail !== "far" && <g opacity=".55" fill="none" stroke="#9a8961" strokeWidth="2"><path d="M71 145Q118 122 160 124T247 141"/><path d="M160 124V171"/><path d="M160 124Q145 94 114 72"/></g>}

      <g transform="translate(160 118)">
        <ellipse cx="0" cy="42" rx="58" ry="12" fill="#171713" opacity=".28"/>
        <rect x="-39" y="-12" width="78" height="49" rx="3" fill={`url(#stone-${seed})`} stroke="#35322e" strokeWidth="2"/>
        <path d="M-39-12h78v10h-78z" fill="#4c4943"/>
        {Array.from({length:towers},(_,i)=>{
          const x=towers===3?[-44,0,44][i]:towers===4?[-47,-16,16,47][i]:[-50,-25,0,25,50][i];
          return <g key={i} transform={`translate(${x} 0)`}><rect x="-9" y="-32" width="18" height="65" rx="2" fill={`url(#stone-${seed})`} stroke="#34312d" strokeWidth="2"/><path d="M-11-32h22l-4-10H-7Z" fill={color} stroke="#3b3028" strokeWidth="1.5"/><rect x="-2.5" y="10" width="5" height="13" fill="#2d2926"/><rect x="-3" y="-15" width="6" height="8" rx="3" fill="#c3a868" opacity=".65"/></g>
        })}
        <path d="M-16 37V8a16 16 0 0 1 32 0v29Z" fill="#302b27"/>
        <path d="M0-42V-67" stroke="#574839" strokeWidth="3"/>
        <path d="M2-66h30l-8 9 8 9H2Z" fill={color} stroke="#3d3026" strokeWidth="1"/>
        {detail === "near" && <g fill="#b59b62" opacity=".7"><rect x="-31" y="0" width="6" height="4"/><rect x="25" y="0" width="6" height="4"/><rect x="-31" y="16" width="6" height="4"/><rect x="25" y="16" width="6" height="4"/></g>}
      </g>

      {damage > .2 && <path d="M135 105l12 13-9 12 14 12" fill="none" stroke="#292621" strokeWidth={2 + damage*3} opacity={.45 + damage*.4}/>} 
      {ruined && <g opacity=".5"><circle cx="147" cy="68" r="10" fill="#3b3732"/><circle cx="158" cy="52" r="15" fill="#4d4841" opacity=".6"/></g>}
    </svg>
  );
}

export const IslandArt = memo(CastleRegionArt);
