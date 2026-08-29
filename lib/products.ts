export type ProductScope = "player" | "state";

export interface GameProduct {
  title: string;
  description: string;
  stars: number;
  scope: ProductScope;
}

export const PRODUCTS: Record<string, GameProduct> = {
  season_pass: {
    title: "Сезонный пропуск",
    description: "Сезонная косметическая ветка WARSTATE",
    stars: 250,
    scope: "player",
  },
  state_banner: {
    title: "Набор знамён государства",
    description: "Премиальный набор оформления государства",
    stars: 125,
    scope: "state",
  },
  city_noir: {
    title: "Ночная тема государства",
    description: "Ночная тема профиля государства",
    stars: 300,
    scope: "state",
  },
  profile_frame: {
    title: "Рамка ветерана",
    description: "Редкая рамка профиля игрока",
    stars: 75,
    scope: "player",
  },
};

export function getProduct(sku: string) {
  return PRODUCTS[sku] || null;
}
