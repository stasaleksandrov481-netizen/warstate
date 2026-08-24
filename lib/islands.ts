import { getSupabaseAdmin } from "@/lib/supabase/server";
import { enforceRateLimit, withActionLock } from "@/lib/redis";
import { getChat, getChatMemberCount } from "@/lib/telegram-bot";
import type { DiplomacyRelationView, IslandView, WarType } from "@/lib/types";
import { requireData, safeInteger, safeNumber } from "@/lib/invariants";

const META_TTL_MS = 30 * 60 * 1000;

export async function syncStateChatMeta(stateId: string, chatId: number, force = false) {
  const supabase = getSupabaseAdmin();
  const { data: current, error } = await supabase
    .from("states")
    .select("*")
    .eq("id", stateId)
    .single();
  if (error) throw error;
  const currentState = requireData(current, "Государство не найдено.");

  const last = currentState.chat_meta_synced_at ? new Date(currentState.chat_meta_synced_at).getTime() : 0;
  if (!force && last && Date.now() - last < META_TTL_MS) return currentState;

  const [chat, memberCount] = await Promise.all([
    getChat(chatId),
    getChatMemberCount(chatId),
  ]);
  if (!chat.title) throw new Error("Telegram не вернул название группы.");
  const patch: Record<string, unknown> = {
    chat_meta_synced_at: new Date().toISOString(),
    telegram_chat_title: chat.title,
    telegram_member_count: Math.max(1, memberCount),
    chat_avatar_file_id: chat.photo?.big_file_id || chat.photo?.small_file_id || null,
  };

  const { data, error: updateError } = await supabase.from("states").update(patch).eq("id", stateId).select("*").single();
  if (updateError) throw updateError;
  return requireData(data, "Не удалось обновить данные Telegram-группы.");
}

export async function getIslandWorld(
  stateId: string,
  diplomacy: DiplomacyRelationView[] = [],
  center?: { x: number; y: number },
  radius = 2600,
): Promise<IslandView[]> {
  const supabase = getSupabaseAdmin();
  let origin = center;
  if (!origin) {
    const { data: mine, error } = await supabase.from("states").select("world_x,world_y").eq("id", stateId).single();
    if (error) throw error;
    const ownState = requireData(mine, "Государство не найдено.");
    origin = { x: safeNumber(ownState.world_x), y: safeNumber(ownState.world_y) };
  }

  const { data, error } = await supabase.rpc("gw_get_islands", {
    p_center_x: origin.x,
    p_center_y: origin.y,
    p_radius: radius,
    p_limit: 120,
  });
  if (error) throw error;

  const relationByState = new Map(diplomacy.map((item) => [item.otherStateId, item.status]));
  const islandRows = [...(data || [])] as any[];
  // The protected beginner island is a global landmark. Radius-based world RPCs
  // used to omit it whenever it lived far from the current camera, which made
  // the island effectively invisible to free players. Always inject configured
  // beginner states so the map/radar can focus and select them from anywhere.
  if (!islandRows.some((row: any) => row.is_beginner_island)) {
    const { data: beginnerRows, error: beginnerError } = await supabase
      .from("states")
      .select("id,name,color,emblem,world_x,world_y,telegram_member_count,rating,island_wins,island_losses,island_integrity,win_streak,last_battle_at,destroyed_until,shield_until,chat_avatar_file_id,is_freeport,is_beginner_island,game_level,max_level,influence,reputation,army_power,defense_power,active_player_count,state_size")
      .eq("is_beginner_island", true)
      .eq("is_freeport", false);
    if (beginnerError) throw beginnerError;
    for (const row of beginnerRows || []) {
      if (!islandRows.some((item: any) => String(item.id) === String(row.id))) islandRows.push({ ...row, rank: 0 });
    }
  }
  const ids = islandRows.map((row: any) => String(row.id)).filter(Boolean);
  const handles = new Map<string, string>();
  if (ids.length) {
    const { data: handleRows, error: handleError } = await supabase.from("states").select("id,state_username").in("id", ids);
    if (handleError) throw handleError;
    for (const row of handleRows || []) if (row.state_username) handles.set(String(row.id), String(row.state_username));
  }
  return islandRows.map((row: any) => ({
    id: row.id,
    name: row.name,
    stateUsername: handles.get(String(row.id)) || null,
    color: row.color,
    emblem: row.emblem || "◆",
    worldX: safeNumber(row.world_x),
    worldY: safeNumber(row.world_y),
    memberCount: Math.max(1, safeInteger(row.telegram_member_count, 1)),
    rating: safeInteger(row.rating, 1000),
    rank: Math.max(0, safeInteger(row.rank)),
    wins: Math.max(0, safeInteger(row.island_wins)),
    losses: Math.max(0, safeInteger(row.island_losses)),
    integrity: Math.max(0, Math.min(100, safeInteger(row.island_integrity, 100))),
    winStreak: Math.max(0, safeInteger(row.win_streak)),
    lastBattleAt: row.last_battle_at || null,
    destroyedUntil: row.destroyed_until || null,
    shieldUntil: row.shield_until || null,
    avatarUrl: row.chat_avatar_file_id ? `/api/telegram/chat-photo?stateId=${encodeURIComponent(row.id)}` : null,
    relation: relationByState.get(row.id) || null,
    isMine: row.id === stateId,
    isFreeport: Boolean(row.is_freeport),
    isBeginnerIsland: Boolean(row.is_beginner_island),
    level: Math.max(1, safeInteger(row.game_level, 1)),
    maxLevel: Math.max(1, safeInteger(row.max_level, 50)),
    influence: safeInteger(row.influence),
    reputation: safeInteger(row.reputation),
    armyPower: Math.max(0, safeInteger(row.army_power)),
    defensePower: Math.max(0, safeInteger(row.defense_power)),
    activePlayers: Math.max(0, safeInteger(row.active_player_count)),
    stateSize: Math.max(0.0001, safeNumber(row.state_size, 1)),
  }));
}

export async function createIslandBattle(attackerStateId: string, defenderStateId: string, battleType: WarType = "raid") {
  await enforceRateLimit(`attack:${attackerStateId}`, 5, 60);
  const lockKey = `battle-start:${[attackerStateId, defenderStateId].sort().join(":")}`;
  return withActionLock(lockKey, 12, async () => {
    const supabase = getSupabaseAdmin();
    const { data: states, error: statesError } = await supabase
      .from("states")
      .select("id,is_freeport,is_beginner_island")
      .in("id", [attackerStateId, defenderStateId]);
    if (statesError) throw statesError;
    if ((states || []).some((state: any) => state.is_freeport)) {
      throw new Error("Freeport — нейтральная территория. Здесь запрещены войны.");
    }
    const attacker = (states || []).find((state: any) => state.id === attackerStateId);
    const defender = (states || []).find((state: any) => state.id === defenderStateId);
    if (attacker?.is_beginner_island) throw new Error("Атаки с Острова новичков запрещены.");
    if (defender?.is_beginner_island) throw new Error("Остров новичков находится под защитой.");
    const durations: Record<WarType, number> = { raid: 900, siege: 1800, territory: 1200 };
    const { data: battleId, error } = await supabase.rpc("gw_start_island_battle", {
      p_attacker_state_id: attackerStateId,
      p_defender_state_id: defenderStateId,
      p_duration_seconds: durations[battleType],
    });
    if (error) throw error;
    if (!battleId) throw new Error("Не удалось начать атаку на остров.");
    const { error: typeError } = await supabase.from("battles").update({ battle_type: battleType }).eq("id", battleId);
    if (typeError) throw typeError;
    return String(battleId);
  });
}


export async function repairIsland(stateId: string, amount = 25) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_repair_island", {
    p_state_id: stateId,
    p_amount: Math.max(1, Math.min(50, Math.round(amount))),
  });
  if (error) throw error;
  return data;
}
