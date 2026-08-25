export type EloLeague = {
  key: "bronze" | "silver" | "gold" | "platinum" | "diamond" | "legend";
  label: string;
  icon: string;
  floor: number;
  ceiling: number | null;
};

const LEAGUES: EloLeague[] = [
  { key: "bronze", label: "Бронза", icon: "◆", floor: 0, ceiling: 1099 },
  { key: "silver", label: "Серебро", icon: "◇", floor: 1100, ceiling: 1399 },
  { key: "gold", label: "Золото", icon: "✦", floor: 1400, ceiling: 1699 },
  { key: "platinum", label: "Платина", icon: "✧", floor: 1700, ceiling: 1999 },
  { key: "diamond", label: "Алмаз", icon: "⬢", floor: 2000, ceiling: 2399 },
  { key: "legend", label: "Легенда", icon: "♛", floor: 2400, ceiling: null },
];

export function eloLeague(rating: number): EloLeague {
  for (let index = LEAGUES.length - 1; index >= 0; index -= 1) {
    if (rating >= LEAGUES[index].floor) return LEAGUES[index];
  }
  return LEAGUES[0];
}

export function eloDeltaPreview(myRating: number, enemyRating: number, k = 36) {
  const expected = 1 / (1 + Math.pow(10, (enemyRating - myRating) / 400));
  return {
    win: Math.max(1, Math.round(k * (1 - expected))),
    lose: Math.max(1, Math.abs(Math.round(k * expected))),
  };
}
