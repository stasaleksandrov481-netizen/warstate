export type ProductScope = "player" | "state";

export interface GameProduct {
  title: string;
  description: string;
  stars: number;
  scope: ProductScope;
}

export const PRODUCTS: Record<string, GameProduct> = {
  season_pass: {
    title: "Season Pass",
    description: "Сезонная косметическая ветка GROUP WARS",
    stars: 250,
    scope: "player",
  },
  state_banner: {
    title: "State Banner Pack",
    description: "Премиальный набор оформления острова-государства",
    stars: 125,
    scope: "state",
  },
  city_noir: {
    title: "Night Island Skin",
    description: "Ночная тема острова и профиля государства",
    stars: 300,
    scope: "state",
  },
  profile_frame: {
    title: "Veteran Profile Frame",
    description: "Редкая рамка профиля игрока",
    stars: 75,
    scope: "player",
  },
};

export function getProduct(sku: string) {
  return PRODUCTS[sku] || null;
}
