"use client";

import { memo, useMemo } from "react";

type Props = {
  id: string;
  members: number;
  color: string;
  integrity: number;
  ruined?: boolean;
  selected?: boolean;
};

function hash(input: string) {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value >>> 0);
}

const COASTS = [
  "M25 91 C29 61 53 42 82 42 C101 25 137 24 156 42 C188 39 213 58 216 85 C219 110 195 124 169 124 C148 141 112 143 91 130 C61 134 34 120 25 91 Z",
  "M23 88 C30 58 54 53 70 37 C91 22 121 29 137 40 C164 29 198 42 212 66 C225 91 207 117 181 124 C161 139 130 135 112 130 C88 142 54 133 38 116 C25 107 18 98 23 88 Z",
  "M28 82 C36 52 65 35 90 40 C109 24 143 29 157 46 C183 39 207 55 214 79 C224 103 203 126 176 126 C152 139 121 132 102 125 C80 137 49 128 35 110 C23 101 21 92 28 82 Z",
  "M30 89 C28 64 48 45 74 44 C93 26 128 27 145 40 C169 31 200 44 210 68 C222 94 205 114 183 123 C160 138 128 136 106 126 C78 139 52 128 40 113 C30 105 25 98 30 89 Z",
];

const LAND = [
  "M39 87 C43 64 64 51 85 51 C104 38 132 37 149 51 C175 48 198 64 200 83 C202 102 184 113 162 113 C143 126 116 126 97 116 C72 121 50 112 39 96 Z",
  "M37 85 C45 62 65 60 79 48 C98 36 119 41 136 49 C157 39 186 53 196 69 C206 88 191 106 169 112 C151 124 127 121 110 116 C89 126 63 117 50 104 C40 98 34 92 37 85 Z",
  "M42 79 C49 59 70 48 91 50 C109 39 132 42 146 54 C167 49 188 61 194 79 C201 96 184 111 164 111 C145 122 122 117 105 113 C87 121 65 114 54 102 C44 95 38 88 42 79 Z",
  "M44 84 C44 65 61 52 80 52 C98 39 125 40 141 51 C161 44 184 55 192 72 C201 91 188 105 169 112 C151 123 127 120 108 113 C85 124 64 115 55 103 C47 98 41 91 44 84 Z",
];

function IslandArtInner({ id, members, color, integrity, ruined = false, selected = false }: Props) {
  const seed = useMemo(() => hash(id), [id]);
  const variant = seed % COASTS.length;
  const tier = members >= 700 ? 4 : members >= 300 ? 3 : members >= 120 ? 2 : 1;
  const treeCount = Math.min(10, 3 + tier * 2);
  const houseCount = Math.min(7, 1 + tier * 2);
  const cliffOpacity = Math.max(0.15, Math.min(0.72, (100 - integrity) / 100));

  const trees = useMemo(() => Array.from({ length: treeCount }, (_, index) => {
    const x = 63 + ((seed >> (index % 12)) + index * 31) % 108;
    const y = 62 + ((seed >> ((index + 4) % 12)) + index * 17) % 43;
    const scale = 0.72 + (((seed + index * 19) % 36) / 100);
    return { x, y, scale };
  }), [seed, treeCount]);

  const houses = useMemo(() => Array.from({ length: houseCount }, (_, index) => {
    const x = 78 + ((seed >> ((index + 2) % 10)) + index * 37) % 84;
    const y = 72 + ((seed >> ((index + 5) % 10)) + index * 11) % 31;
    const scale = 0.72 + (((seed + index * 23) % 24) / 100);
    return { x, y, scale };
  }), [seed, houseCount]);

  return (
    <svg className={`island-art ${ruined ? "ruined" : ""} ${selected ? "selected" : ""}`} viewBox="0 0 240 160" role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`seaGlow-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8ef5ff" stopOpacity=".85" />
          <stop offset="1" stopColor="#1c99d4" stopOpacity=".05" />
        </linearGradient>
        <linearGradient id={`beach-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2dda1" />
          <stop offset="1" stopColor="#b98f50" />
        </linearGradient>
        <linearGradient id={`land-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={ruined ? "#4a4a43" : "#5eb451"} />
          <stop offset=".55" stopColor={ruined ? "#33352f" : "#2f833d"} />
          <stop offset="1" stopColor={ruined ? "#20241f" : "#17612f"} />
        </linearGradient>
        <linearGradient id={`roof-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4f7ff" />
          <stop offset=".2" stopColor={color} />
          <stop offset="1" stopColor="#27334a" />
        </linearGradient>
        <filter id={`shadow-${seed}`} x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#00131f" floodOpacity=".72" />
        </filter>
        <filter id={`select-${seed}`} x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#55c8ff" floodOpacity={selected ? ".95" : ".18"} />
        </filter>
      </defs>

      <ellipse cx="121" cy="120" rx="84" ry="22" fill="#001827" opacity=".55" />
      <path d={COASTS[variant]} fill={`url(#seaGlow-${seed})`} opacity=".78" transform="translate(0 4)" filter={`url(#select-${seed})`} />
      <path d={COASTS[variant]} fill={`url(#beach-${seed})`} filter={`url(#shadow-${seed})`} />
      <path d={LAND[variant]} fill={`url(#land-${seed})`} />

      <path d="M45 91 C73 111 112 119 155 110 C178 105 191 91 199 78 C195 103 182 117 161 124 C137 139 105 134 89 126 C67 132 48 119 39 103 Z" fill="#123b2b" opacity=".55" />
      <path d="M52 101 C79 117 111 123 148 116 C172 111 188 99 196 88" fill="none" stroke="#7b6547" strokeWidth="5" strokeLinecap="round" opacity=".72" />

      <g opacity={ruined ? .3 : .98}>
        {trees.map((tree, index) => (
          <g key={index} transform={`translate(${tree.x} ${tree.y}) scale(${tree.scale})`}>
            <rect x="-1.5" y="6" width="3" height="8" rx="1" fill="#5d4933" />
            <circle cx="0" cy="1" r="7" fill={index % 3 === 0 ? "#247337" : "#1c5f31"} />
            <circle cx="-4" cy="3" r="4" fill="#2f8b3f" />
            <circle cx="4" cy="3" r="4" fill="#3a9648" />
          </g>
        ))}
      </g>

      <g opacity={ruined ? .52 : 1}>
        {houses.map((house, index) => (
          <g key={index} transform={`translate(${house.x} ${house.y}) scale(${house.scale})`}>
            <rect x="-6" y="-1" width="12" height="9" rx="1" fill="#d2c5a2" />
            <polygon points="-8,-1 0,-7 8,-1" fill={index % 2 === 0 ? color : "#ab6c41"} />
            <rect x="-2" y="3" width="3" height="5" fill="#4f3d31" />
          </g>
        ))}
      </g>

      <g transform="translate(121 69)">
        <ellipse cx="0" cy="20" rx={18 + tier * 3} ry="7" fill="#09221a" opacity=".48" />
        <rect x={-11 - tier} y={-2 - tier} width={22 + tier * 2} height={24 + tier * 2} rx="2" fill={ruined ? "#4b4c4b" : "#d8d6c5"} />
        <rect x={-7 - tier} y={2 - tier} width={14 + tier * 2} height={20 + tier} fill={ruined ? "#2d2e2e" : "#7d8791"} />
        <polygon points={`${-16 - tier},${-2-tier} 0,${-17-tier*2} ${16+tier},${-2-tier}`} fill={`url(#roof-${seed})`} />
        <rect x="-2" y="10" width="5" height="10" fill="#27313a" />
        {tier >= 3 && <><rect x="-20" y="3" width="8" height="20" fill="#aeb5b5" /><polygon points="-22,3 -16,-8 -10,3" fill={color} /><rect x="12" y="3" width="8" height="20" fill="#aeb5b5" /><polygon points="10,3 16,-8 22,3" fill={color} /></>}
        {tier >= 4 && <><rect x="-3" y="-27" width="6" height="15" fill="#adb3b2" /><polygon points="-6,-27 0,-37 6,-27" fill={color} /></>}
      </g>

      {tier >= 2 && <g transform="translate(66 101)"><rect x="0" y="0" width="26" height="4" rx="2" fill="#9d7544" /><rect x="2" y="4" width="3" height="10" fill="#5f482f" /><rect x="20" y="4" width="3" height="10" fill="#5f482f" /></g>}
      {tier >= 3 && <g transform="translate(171 86)"><rect x="0" y="0" width="2" height="22" fill="#d8e5ef" /><path d="M2 2 L17 7 L2 13 Z" fill={color} /></g>}

      {integrity < 100 && !ruined && (
        <g opacity={cliffOpacity + .2}>
          <path d="M78 97 l12 -7 l8 9 l-10 10 Z" fill="#392f2a" />
          <path d="M154 86 l8 -4 l9 8 l-8 11 Z" fill="#392f2a" />
        </g>
      )}

      {ruined && (
        <g>
          <ellipse cx="121" cy="82" rx="29" ry="14" fill="#251b1a" opacity=".9" />
          <ellipse cx="121" cy="82" rx="19" ry="9" fill="#100d0d" opacity=".9" />
          <path d="M98 73 l13 7 l-8 13" stroke="#9b4d35" strokeWidth="3" fill="none" opacity=".8" />
          <path d="M137 70 l-9 11 l12 8" stroke="#9b4d35" strokeWidth="3" fill="none" opacity=".8" />
          <g className="island-svg-smoke">
            <circle cx="111" cy="52" r="7" fill="#686869" opacity=".55" />
            <circle cx="119" cy="43" r="10" fill="#4f5153" opacity=".5" />
            <circle cx="132" cy="34" r="12" fill="#404245" opacity=".42" />
          </g>
        </g>
      )}
    </svg>
  );
}

export const IslandArt = memo(IslandArtInner);
