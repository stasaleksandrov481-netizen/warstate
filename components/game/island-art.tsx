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
};

type Anchor = { x: number; y: number; scale?: number };

function hash(input: string) {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value >>> 0);
}

/*
 * Coast and land are paired. Decoration never uses arbitrary coordinates:
 * every tree/house comes from SAFE_* anchors that sit well inside all four
 * land silhouettes. This prevents buildings from drifting into the sea.
 */
const COASTS = [
  "M22 96 C25 72 44 56 68 51 C81 34 111 29 132 38 C151 28 183 37 195 56 C218 61 229 79 225 99 C221 120 199 132 176 132 C155 146 122 148 99 136 C72 142 45 132 32 116 C24 109 20 103 22 96 Z",
  "M20 91 C26 68 47 59 65 45 C87 27 112 34 132 42 C157 31 190 42 205 62 C220 82 213 108 191 123 C174 137 149 138 128 132 C102 146 72 137 54 124 C35 119 19 106 20 91 Z",
  "M28 88 C34 62 57 43 82 43 C100 28 130 31 148 44 C174 36 204 48 217 71 C230 96 213 120 187 129 C164 142 133 137 111 132 C86 143 56 134 41 118 C28 109 23 99 28 88 Z",
  "M27 94 C24 70 45 48 71 48 C91 29 123 31 143 43 C169 34 198 46 212 66 C226 88 217 112 194 125 C171 142 140 140 115 131 C89 143 59 136 42 119 C31 112 25 103 27 94 Z",
];

const LAND = [
  "M38 91 C42 70 57 61 77 58 C91 44 114 42 132 49 C150 40 175 47 185 61 C203 66 211 80 207 95 C203 110 187 118 169 118 C151 130 125 131 105 121 C82 127 60 118 49 106 C42 101 37 96 38 91 Z",
  "M37 88 C42 69 60 64 74 53 C91 41 111 46 129 52 C149 43 176 53 188 67 C199 82 193 101 176 112 C161 123 142 123 124 118 C103 129 79 122 64 111 C49 108 36 99 37 88 Z",
  "M44 84 C50 63 68 52 88 53 C103 42 127 45 142 54 C163 48 185 58 195 74 C205 92 192 108 173 114 C155 125 132 121 115 117 C94 126 71 119 59 107 C49 101 40 94 44 84 Z",
  "M43 89 C41 70 58 56 78 56 C94 43 118 44 136 53 C156 46 179 56 190 70 C201 86 195 104 177 113 C159 125 136 123 117 116 C96 126 73 121 60 109 C50 104 43 98 43 89 Z",
];

const SAFE_HOUSES: Anchor[] = [
  { x: 82, y: 88, scale: .88 },
  { x: 99, y: 102, scale: .82 },
  { x: 145, y: 96, scale: .88 },
  { x: 163, y: 83, scale: .76 },
  { x: 150, y: 110, scale: .72 },
  { x: 72, y: 104, scale: .72 },
  { x: 104, y: 70, scale: .68 },
  { x: 148, y: 69, scale: .68 },
];

const SAFE_TREES: Anchor[] = [
  { x: 67, y: 73 }, { x: 77, y: 64 }, { x: 88, y: 112 }, { x: 96, y: 58 },
  { x: 109, y: 113 }, { x: 139, y: 58 }, { x: 158, y: 66 }, { x: 177, y: 75 },
  { x: 173, y: 100 }, { x: 136, y: 116 }, { x: 60, y: 93 }, { x: 188, y: 91 },
  { x: 122, y: 54 }, { x: 118, y: 116 },
];

function jitter(seed: number, index: number, spread: number) {
  return (((seed >>> (index % 13)) + index * 17) % (spread * 2 + 1)) - spread;
}

function IslandArtInner({ id, members, color, integrity, ruined = false, selected = false, detail = "near" }: Props) {
  const seed = useMemo(() => hash(id), [id]);
  const variant = seed % COASTS.length;
  const tier = members >= 1500 ? 5 : members >= 700 ? 4 : members >= 300 ? 3 : members >= 120 ? 2 : 1;
  const houseCount = detail === "far" ? 0 : Math.min(SAFE_HOUSES.length, tier + (detail === "near" ? 2 : 0));
  const treeCount = detail === "far" ? Math.min(4, 2 + tier) : Math.min(SAFE_TREES.length, 5 + tier * 2);
  const damage = Math.max(0, Math.min(1, (100 - integrity) / 100));

  const houses = useMemo(() => {
    const offset = seed % SAFE_HOUSES.length;
    return Array.from({ length: houseCount }, (_, i) => {
      const base = SAFE_HOUSES[(i + offset) % SAFE_HOUSES.length];
      return {
        x: base.x + jitter(seed, i + 3, 2),
        y: base.y + jitter(seed, i + 8, 2),
        scale: (base.scale || 1) * (.94 + ((seed + i * 29) % 12) / 100),
      };
    });
  }, [houseCount, seed]);

  const trees = useMemo(() => {
    const offset = (seed >>> 5) % SAFE_TREES.length;
    return Array.from({ length: treeCount }, (_, i) => {
      const base = SAFE_TREES[(i + offset) % SAFE_TREES.length];
      return {
        x: base.x + jitter(seed, i + 11, 2),
        y: base.y + jitter(seed, i + 19, 2),
        scale: .76 + ((seed + i * 31) % 28) / 100,
      };
    });
  }, [seed, treeCount]);

  return (
    <svg className={`island-art ${ruined ? "ruined" : ""} ${selected ? "selected" : ""}`} viewBox="0 0 240 170" role="img" aria-hidden="true">
      <defs>
        <linearGradient id={`beach-${seed}`} x1="0" y1="0" x2=".7" y2="1">
          <stop offset="0" stopColor="#ffe4a3" />
          <stop offset=".55" stopColor="#e5bc6d" />
          <stop offset="1" stopColor="#a8753f" />
        </linearGradient>
        <linearGradient id={`land-${seed}`} x1=".12" y1="0" x2=".8" y2="1">
          <stop offset="0" stopColor={ruined ? "#77705e" : "#8acb55"} />
          <stop offset=".47" stopColor={ruined ? "#545343" : "#4f9f3f"} />
          <stop offset="1" stopColor={ruined ? "#34372e" : "#256f37"} />
        </linearGradient>
        <linearGradient id={`landShade-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#10351f" stopOpacity="0" />
          <stop offset="1" stopColor="#153824" stopOpacity=".72" />
        </linearGradient>
        <linearGradient id={`roof-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff3cf" />
          <stop offset=".24" stopColor={color} />
          <stop offset="1" stopColor="#493e55" />
        </linearGradient>
        <filter id={`softShadow-${seed}`} x="-30%" y="-30%" width="160%" height="190%">
          <feDropShadow dx="0" dy="7" stdDeviation="5" floodColor="#062e3e" floodOpacity=".42" />
        </filter>
        <filter id={`foamGlow-${seed}`} x="-30%" y="-30%" width="160%" height="170%">
          <feGaussianBlur stdDeviation="1.3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath id={`landClip-${seed}`}>
          <path d={LAND[variant]} />
        </clipPath>
      </defs>

      {/* Contact shadow in the water. */}
      <ellipse cx="121" cy="129" rx="83" ry="19" fill="#06445a" opacity=".28" />

      {/* Shallow water + surf. The dashed white edge is the animated foam line. */}
      <path className="island-shallow" d={COASTS[variant]} fill="none" stroke="#66d5db" strokeWidth="15" strokeLinejoin="round" opacity={ruined ? .24 : .42} />
      <path className="island-foam-soft" d={COASTS[variant]} fill="none" stroke="#bff8f0" strokeWidth="8" strokeLinejoin="round" opacity={ruined ? .28 : .62} filter={`url(#foamGlow-${seed})`} />
      <path className="island-foam" d={COASTS[variant]} fill="none" stroke="#f2fff5" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="11 5 4 6" opacity={ruined ? .35 : .94} />

      {detail !== "far" && (
        <g className="island-surf-lines" fill="none" strokeLinecap="round">
          <path d="M32 129 C62 145 91 148 118 145" stroke="#e7fff7" strokeWidth="2" opacity=".72" />
          <path d="M139 146 C169 145 197 136 214 121" stroke="#d7fff6" strokeWidth="1.8" opacity=".62" />
          <path d="M47 140 C69 151 91 153 107 151" stroke="#8fe4e5" strokeWidth="1.3" opacity=".55" />
          <path d="M172 151 C192 146 207 138 220 127" stroke="#8fe4e5" strokeWidth="1.3" opacity=".5" />
        </g>
      )}

      {/* Beach and grass use the same paired silhouette. */}
      <path d={COASTS[variant]} fill={`url(#beach-${seed})`} filter={detail === "far" ? undefined : `url(#softShadow-${seed})`} />
      <path d={LAND[variant]} fill={`url(#land-${seed})`} />
      <path d={LAND[variant]} fill={`url(#landShade-${seed})`} opacity=".48" transform="translate(0 5) translate(0 90) scale(1 .96) translate(0 -90)" />

      {/* Every land decoration is clipped by the grass silhouette as a final
          guardrail: even a future bad anchor cannot render a house in water. */}
      <g clipPath={`url(#landClip-${seed})`}>
      {/* Interior paths. */}
      {detail === "near" && !ruined && (
        <g fill="none" stroke="#ead59c" strokeLinecap="round" opacity=".76">
          <path d="M80 94 C96 89 105 78 120 73 C138 78 151 86 165 94" strokeWidth="2.1" strokeDasharray="2 3" />
          <path d="M120 74 C121 89 113 102 102 112" strokeWidth="1.7" strokeDasharray="2 3" />
        </g>
      )}

      {/* Trees stay inside predefined safe anchors. */}
      <g opacity={ruined ? .3 : .98}>
        {trees.map((tree, index) => (
          <g key={index} transform={`translate(${tree.x} ${tree.y}) scale(${tree.scale})`}>
            <ellipse cx="1" cy="12" rx="6" ry="2.5" fill="#184a2b" opacity=".32" />
            <rect x="-1.5" y="5" width="3" height="9" rx="1" fill="#74502f" />
            <circle cx="0" cy="1" r="7" fill={index % 3 === 0 ? "#347b35" : "#27692f"} />
            <circle cx="-4" cy="3" r="4" fill="#4b963f" />
            <circle cx="4" cy="3" r="4" fill="#5ca84a" />
          </g>
        ))}
      </g>

      {/* Houses also use safe anchors, no free random positioning. */}
      <g opacity={ruined ? .46 : 1}>
        {houses.map((house, index) => (
          <g key={index} transform={`translate(${house.x} ${house.y}) scale(${house.scale})`}>
            <ellipse cx="0" cy="8" rx="8" ry="2.4" fill="#16412b" opacity=".28" />
            <rect x="-6" y="-1" width="12" height="9" rx="1.4" fill="#f0d9a7" stroke="#7f6a4b" strokeWidth=".7" />
            <polygon points="-8,-1 0,-7 8,-1" fill={index % 2 === 0 ? color : "#c96d45"} stroke="#59414a" strokeWidth=".7" />
            <rect x="-1.7" y="3" width="3.4" height="5" rx=".6" fill="#5c4434" />
            <rect x="-5" y="2" width="2.5" height="2.4" rx=".5" fill="#9ee6ff" opacity=".9" />
          </g>
        ))}
      </g>
      </g>

      {/* Central keep always sits in the widest safe interior area. */}
      <g transform="translate(121 73)" opacity={ruined ? .72 : 1}>
        <ellipse cx="0" cy="21" rx={18 + tier * 3} ry="7" fill="#123a28" opacity=".35" />
        <rect x={-11 - tier} y={-2 - tier} width={22 + tier * 2} height={24 + tier * 2} rx="2.5" fill={ruined ? "#706d64" : "#f0dfbd"} stroke="#6a645b" strokeWidth="1" />
        <rect x={-7 - tier} y={2 - tier} width={14 + tier * 2} height={20 + tier} rx="1.5" fill={ruined ? "#444741" : "#8d9a92"} />
        <polygon points={`${-16 - tier},${-2 - tier} 0,${-17 - tier * 2} ${16 + tier},${-2 - tier}`} fill={`url(#roof-${seed})`} stroke="#493f4a" strokeWidth="1" />
        <rect x="-2.5" y="10" width="5" height="10" rx="1" fill="#4d3d34" />
        <rect x="-7" y="5" width="4" height="4" rx=".7" fill="#b9efff" />
        <rect x="3" y="5" width="4" height="4" rx=".7" fill="#b9efff" />
        {tier >= 3 && <>
          <rect x="-20" y="3" width="8" height="20" rx="1.5" fill="#d7cda9" stroke="#6a645b" strokeWidth=".8" />
          <polygon points="-22,3 -16,-8 -10,3" fill={color} />
          <rect x="12" y="3" width="8" height="20" rx="1.5" fill="#d7cda9" stroke="#6a645b" strokeWidth=".8" />
          <polygon points="10,3 16,-8 22,3" fill={color} />
        </>}
        {tier >= 4 && <>
          <rect x="-3" y="-27" width="6" height="15" rx="1" fill="#e0d5b5" />
          <polygon points="-6,-27 0,-37 6,-27" fill={color} />
        </>}
      </g>

      {/* Pier and flag are anchored on land-facing shoreline, not free-floating. */}
      {tier >= 2 && detail !== "far" && <g transform="translate(65 111)">
        <rect x="0" y="0" width="27" height="4" rx="2" fill="#a97743" stroke="#6d4930" strokeWidth=".7" />
        <rect x="3" y="4" width="3" height="10" fill="#6a4831" /><rect x="21" y="4" width="3" height="10" fill="#6a4831" />
        <path d="M-10 14 Q2 9 14 14" fill="none" stroke="#f2fff6" strokeWidth="1.2" opacity=".7" />
      </g>}
      {tier >= 3 && <g transform="translate(171 84)">
        <rect x="0" y="0" width="2" height="26" rx="1" fill="#f6e8c4" />
        <path d="M2 3 L18 8 L2 15 Z" fill={color} stroke="#463f4a" strokeWidth=".7" />
      </g>}

      {/* A tiny boat at higher tiers gives the island life without expensive sprites. */}
      {tier >= 4 && detail === "near" && !ruined && <g className="island-boat" transform="translate(191 132) rotate(-8)">
        <path d="M-10 0 Q0 7 12 0 L8 6 Q0 10 -8 6 Z" fill="#8e5b35" stroke="#5d3c2a" strokeWidth=".8" />
        <rect x="0" y="-10" width="1.4" height="11" fill="#5c4532" />
        <path d="M1 -9 L8 -4 L1 -2 Z" fill="#fff1bd" />
        <path d="M-15 8 Q-3 4 9 8" fill="none" stroke="#e8fff8" strokeWidth="1.5" opacity=".8" />
      </g>}

      {integrity < 100 && !ruined && (
        <g opacity={Math.max(.2, damage)}>
          <path d="M79 98 l11 -7 l8 9 l-10 9 Z" fill="#46332b" />
          <path d="M153 88 l8 -4 l9 8 l-8 10 Z" fill="#46332b" />
          {damage > .45 && <path d="M109 110 l8 -5 l7 6 l-5 7 Z" fill="#332622" />}
        </g>
      )}

      {ruined && (
        <g>
          <ellipse cx="121" cy="86" rx="31" ry="15" fill="#34231f" opacity=".9" />
          <ellipse cx="121" cy="86" rx="19" ry="9" fill="#161111" opacity=".9" />
          <path d="M99 77 l13 7 l-8 13" stroke="#a14e35" strokeWidth="3" fill="none" opacity=".8" />
          <path d="M139 74 l-10 11 l13 8" stroke="#a14e35" strokeWidth="3" fill="none" opacity=".8" />
          <g className="island-svg-smoke">
            <circle cx="111" cy="54" r="7" fill="#77736d" opacity=".52" />
            <circle cx="120" cy="44" r="10" fill="#5a5956" opacity=".48" />
            <circle cx="132" cy="34" r="12" fill="#444544" opacity=".4" />
          </g>
        </g>
      )}
    </svg>
  );
}

export const IslandArt = memo(IslandArtInner);
