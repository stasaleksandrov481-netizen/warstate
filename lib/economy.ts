import { getSupabaseAdmin } from "@/lib/supabase/server";

export type EconomyResource = "steel" | "fuel" | "food" | "tech";

export type PersonalEconomyView = {
  coins: number;
  inventory: { steel: number; fuel: number; food: number; tech: number };
  dutyRole: "diplomat" | "spy" | "miner" | "worker" | null;
  gatherCooldownSeconds: number;
  toolTier: number;
  toolUsesLeft: number;
  homeLevel: number;
  homeHourlyCoins: number;
  homeIncomeCollected: number;
  gatherBoostUntil: string | null;
  cooldownElixirs: number;
  gatherBoostElixirs: number;
  nobleTitle: string | null;
  economySleeping: boolean;
};

function normalizeEconomy(data: any): PersonalEconomyView {
  if (!data || typeof data !== "object") throw new Error("Экономика игрока не инициализирована. Примените миграцию 040_personal_economy_v54.sql.");
  const inventory = data.inventory && typeof data.inventory === "object" ? data.inventory : {};
  return {
    coins: Number(data.coins || 0),
    inventory: {
      steel: Number(inventory.steel || 0),
      fuel: Number(inventory.fuel || 0),
      food: Number(inventory.food || 0),
      tech: Number(inventory.tech || 0),
    },
    dutyRole: data.dutyRole || null,
    gatherCooldownSeconds: Math.max(0, Number(data.gatherCooldownSeconds || 0)),
    toolTier: Math.max(0, Number(data.toolTier || 0)),
    toolUsesLeft: Math.max(0, Number(data.toolUsesLeft || 0)),
    homeLevel: Math.max(0, Number(data.homeLevel || 0)),
    homeHourlyCoins: Math.max(0, Number(data.homeHourlyCoins || 0)),
    homeIncomeCollected: Math.max(0, Number(data.homeIncomeCollected || 0)),
    gatherBoostUntil: data.gatherBoostUntil || null,
    cooldownElixirs: Math.max(0, Number(data.cooldownElixirs || 0)),
    gatherBoostElixirs: Math.max(0, Number(data.gatherBoostElixirs || 0)),
    nobleTitle: data.nobleTitle || null,
    economySleeping: Boolean(data.economySleeping),
  };
}

export async function getPersonalEconomy(playerId: string, stateId: string): Promise<PersonalEconomyView> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_personal_economy_snapshot", { p_player_id: playerId, p_state_id: stateId });
  if (error) {
    const code = String((error as any)?.code || "");
    if (["PGRST202", "42883"].includes(code)) throw new Error("Не применена миграция 040_personal_economy_v54.sql.");
    throw error;
  }
  return normalizeEconomy(data);
}

export async function gatherPersonalResources(playerId: string, stateId: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_personal_gather", { p_player_id: playerId, p_state_id: stateId });
  if (error) throw error;
  return data as { steel: number; fuel: number; food: number; tech: number; role: string | null; toolUsesLeft: number; economySleeping: boolean };
}

export async function sellPersonalResource(playerId: string, stateId: string, resource: string, amount: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_sell_personal_resource", { p_player_id: playerId, p_state_id: stateId, p_resource: resource, p_amount: amount });
  if (error) throw error;
  return data as { resource: EconomyResource; amount: number; coins: number; multiplier: number; wokeEconomy: boolean };
}

export async function buyPersonalItem(playerId: string, item: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_buy_personal_item", { p_player_id: playerId, p_item: item });
  if (error) throw error;
  return data as { item: string; label: string; price: number };
}

export async function usePersonalConsumable(playerId: string, item: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_use_personal_consumable", { p_player_id: playerId, p_item: item });
  if (error) throw error;
  return data as { item: string; message: string };
}

export async function buyNobleTitle(playerId: string, title: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_buy_noble_title", { p_player_id: playerId, p_title: title });
  if (error) throw error;
  return data as { title: string; price: number };
}

export async function investGlory(playerId: string, stateId: string, amount: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_invest_glory", { p_player_id: playerId, p_state_id: stateId, p_amount: amount });
  if (error) throw error;
  return data as { coins: number; elo: number; dailyRemaining: number };
}

export async function wildRaid(playerId: string, stateId: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gw_wild_raid", { p_player_id: playerId, p_state_id: stateId });
  if (error) throw error;
  return data as { success: boolean; resource: EconomyResource | null; amount: number };
}
