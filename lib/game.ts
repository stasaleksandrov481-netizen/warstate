import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getChat, getChatMember, getChatMemberCount } from "@/lib/telegram-bot";
import { findActiveBattleForState } from "@/lib/battle";
import { getDiplomacyForState, getLeaderboard, getWorldFeed, recordWorldEvent } from "@/lib/diplomacy";
import { getDailyMissions, recordMissionProgress } from "@/lib/missions";
import { ensureMilestoneBadges, getActiveSeason, getElection, getStateBadges } from "@/lib/politics";
import { getIslandWorld, syncStateChatMeta } from "@/lib/islands";
import type { BuildingType, BuildingView, GameSnapshot, TileView } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";

const BUILDING_META: Record<BuildingType, { label: string; description: string; x: number; y: number }> = {
  hq: { label: "Штаб", description: "Рейтинг, защита столицы и лимиты государства", x: 50, y: 36 },
  barracks: { label: "Казармы", description: "Повышают силу атакующей армии", x: 31, y: 53 },
  mine: { label: "Шахта", description: "Производит сталь", x: 69, y: 56 },
  refinery: { label: "НПЗ", description: "Производит топливо", x: 76, y: 30 },
  farm: { label: "Ферма", description: "Производит продовольствие", x: 22, y: 27 },
  lab: { label: "Лаборатория", description: "Производит технологии", x: 52, y: 67 },
};

const BASE_COSTS: Record<BuildingType, Partial<Record<"credits" | "steel" | "fuel" | "food" | "tech", number>>> = {
  hq: { credits: 1800, steel: 500, tech: 30 },
  barracks: { credits: 1200, steel: 420, food: 220 },
  mine: { credits: 900, steel: 180 },
  refinery: { credits: 1100, steel: 220 },
  farm: { credits: 700, steel: 100 },
  lab: { credits: 1500, steel: 300, tech: 20 },
};

function scaleCost(type: BuildingType, level: number) {
  const factor = Math.pow(1.65, Math.max(0, level - 1));
  return Object.fromEntries(
    Object.entries(BASE_COSTS[type]).map(([key, value]) => [key, Math.round((value || 0) * factor)]),
  );
}

export function production(buildings: Array<{ building_type: BuildingType; level: number }>) {
  const levels = Object.fromEntries(buildings.map((b) => [b.building_type, b.level])) as Partial<Record<BuildingType, number>>;
  return {
    credits: 320 + (levels.hq || 1) * 95,
    steel: 80 + (levels.mine || 1) * 115,
    fuel: 35 + (levels.refinery || 1) * 72,
    food: 100 + (levels.farm || 1) * 130,
    tech: 8 + (levels.lab || 1) * 18,
  };
}

export async function tickState(stateId: string) {
  const supabase = getSupabaseAdmin();
  const { data: buildings, error: buildingsError } = await supabase
    .from("buildings")
    .select("building_type, level")
    .eq("state_id", stateId);
  if (buildingsError) throw buildingsError;

  const rates = production((buildings || []) as Array<{ building_type: BuildingType; level: number }>);
  const { data, error } = await supabase.rpc("gw_tick_state", {
    p_state_id: stateId,
    p_credits_rate: rates.credits,
    p_steel_rate: rates.steel,
    p_fuel_rate: rates.fuel,
    p_food_rate: rates.food,
    p_tech_rate: rates.tech,
  });
  if (error) throw error;
  return data;
}

async function upsertPlayer(user: TelegramUser) {
  const supabase = getSupabaseAdmin();
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || String(user.id);
  const { data, error } = await supabase
    .from("players")
    .upsert(
      {
        telegram_id: user.id,
        username: user.username || null,
        display_name: displayName,
        avatar_url: user.photo_url || null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "telegram_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function ensureStateForChat(chatId: number, playerId: string, telegramUserId: number) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: selectError } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing;

  const member = await getChatMember(chatId, telegramUserId);
  if (member.status !== "administrator" && member.status !== "creator") {
    throw new Error("Государство ещё не создано. Первый запуск должен сделать администратор Telegram-группы.");
  }

  const [chat, memberCount] = await Promise.all([getChat(chatId), getChatMemberCount(chatId).catch(() => 1)]);
  const color = `hsl(${Math.abs(chatId) % 360} 78% 56%)`;
  const { data: created, error } = await supabase
    .from("states")
    .insert({
      telegram_chat_id: chatId,
      name: chat.title || `State ${Math.abs(chatId)}`,
      owner_player_id: playerId,
      color,
      telegram_member_count: Math.max(1, memberCount || 1),
      chat_avatar_file_id: chat.photo?.big_file_id || chat.photo?.small_file_id || null,
      chat_meta_synced_at: new Date().toISOString(),
      shield_until: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).single();
      return data;
    }
    throw error;
  }

  const buildingRows = (Object.keys(BUILDING_META) as BuildingType[]).map((building_type) => ({
    state_id: created.id,
    building_type,
    level: 1,
  }));
  const { error: buildingError } = await supabase.from("buildings").insert(buildingRows);
  if (buildingError) throw buildingError;

  await recordWorldEvent({
    eventType: "state_founded",
    title: "Новое государство",
    body: `${created.name} появилось на мировой карте.`,
    actorStateId: created.id,
  }).catch(() => null);

  // v0.9+: a chat owns one island directly. The legacy hex map is no longer allocated.


  return created;
}

export async function bootstrapGame(user: TelegramUser, chatId: number): Promise<GameSnapshot> {
  const supabase = getSupabaseAdmin();
  const membership = await getChatMember(chatId, user.id);
  if (membership.status === "left" || membership.status === "kicked") throw new Error("Вы не состоите в этой Telegram-группе.");

  const player = await upsertPlayer(user);
  let state = await ensureStateForChat(chatId, player.id, user.id);
  state = await syncStateChatMeta(state.id, chatId).catch(() => state);

  const { data: existingMember } = await supabase
    .from("state_members")
    .select("role")
    .eq("state_id", state.id)
    .eq("player_id", player.id)
    .maybeSingle();
  const role = state.owner_player_id === player.id
    ? "president"
    : membership.status === "administrator" || membership.status === "creator"
      ? (existingMember?.role === "general" ? "general" : "minister")
      : existingMember?.role === "general"
        ? "general"
        : "citizen";
  const { data: member, error: memberError } = await supabase
    .from("state_members")
    .upsert({ state_id: state.id, player_id: player.id, role, membership_verified_at: new Date().toISOString() }, { onConflict: "state_id,player_id" })
    .select("*")
    .single();
  if (memberError) throw memberError;

  state = await tickState(state.id);
  await recordMissionProgress(player.id, state.id, "check_in").catch(() => null);
  return getGameSnapshot(player.id, state.id, user.id, member.role, "live");
}

export async function getGameSnapshot(
  playerId: string,
  stateId: string,
  telegramId: number,
  role: string,
  mode: "live" = "live",
): Promise<GameSnapshot> {
  const supabase = getSupabaseAdmin();
  const [playerRes, stateRes, buildingsRes, membersRes, myMemberRes] = await Promise.all([
    supabase.from("players").select("id,display_name,username,level,xp,energy").eq("id", playerId).single(),
    supabase.from("states").select("id,name,color,motto,emblem,theme,telegram_chat_id,credits,steel,fuel,food,tech,rating,rating_peak,telegram_member_count,world_x,world_y,island_wins,island_losses,destroyed_until,chat_avatar_file_id,shield_until,next_attack_at,island_integrity,win_streak,best_win_streak,last_battle_at").eq("id", stateId).single(),
    supabase.from("buildings").select("building_type,level").eq("state_id", stateId).order("building_type"),
    supabase.from("state_members").select("id", { count: "exact", head: true }).eq("state_id", stateId),
    supabase.from("state_members").select("contribution").eq("state_id", stateId).eq("player_id", playerId).single(),
  ]);
  for (const response of [playerRes, stateRes, buildingsRes, membersRes, myMemberRes]) {
    if (response.error) throw response.error;
  }

  const player = playerRes.data;
  const state = stateRes.data;
  const buildingsRaw = (buildingsRes.data || []) as Array<{ building_type: BuildingType; level: number }>;
  const rates = production(buildingsRaw);
  // Island World no longer ships the legacy 127-hex map in every snapshot.
  const territoryCount = 1;
  const wins = state.island_wins || 0;
  const [rankRes, diplomacy, worldFeed, leaderboard, dailyMissions, activeBattle, season, election] = await Promise.all([
    supabase.from("states").select("id", { count: "exact", head: true }).gt("rating", state.rating),
    getDiplomacyForState(stateId),
    getWorldFeed(24),
    getLeaderboard(10),
    getDailyMissions(playerId, stateId),
    findActiveBattleForState(stateId, playerId),
    getActiveSeason(),
    getElection(stateId, playerId),
  ]);
  const islands = await getIslandWorld(stateId, diplomacy, { x: Number(state.world_x || 0), y: Number(state.world_y || 0) });
  if (rankRes.error) throw rankRes.error;
  await ensureMilestoneBadges(stateId, season?.id || null, state.rating, territoryCount, wins).catch(() => null);
  const badges = await getStateBadges(stateId);

  const buildings: BuildingView[] = buildingsRaw.map((b) => ({
    type: b.building_type,
    level: b.level,
    upgradeCost: scaleCost(b.building_type, b.level + 1),
    ...BUILDING_META[b.building_type],
  }));

  const tiles: TileView[] = [];

  return {
    mode,
    player: {
      id: player.id,
      telegramId,
      displayName: player.display_name,
      username: player.username,
      level: player.level,
      xp: player.xp,
      energy: player.energy,
      contribution: myMemberRes.data?.contribution || 0,
      role,
    },
    state: {
      id: state.id,
      name: state.name,
      color: state.color,
      motto: state.motto || "Сила в единстве",
      emblem: state.emblem || "◆",
      theme: state.theme || "violet",
      telegramChatId: Number(state.telegram_chat_id),
      treasury: {
        credits: state.credits,
        steel: state.steel,
        fuel: state.fuel,
        food: state.food,
        tech: state.tech,
      },
      productionPerHour: rates,
      rating: state.rating,
      memberCount: state.telegram_member_count || membersRes.count || 1,
      territoryCount,
      seasonRank: (rankRes.count || 0) + 1,
      worldX: Number(state.world_x || 0),
      worldY: Number(state.world_y || 0),
      islandWins: state.island_wins || 0,
      islandLosses: state.island_losses || 0,
      ratingPeak: state.rating_peak || state.rating,
      islandIntegrity: state.island_integrity ?? 100,
      winStreak: state.win_streak || 0,
      bestWinStreak: state.best_win_streak || 0,
      lastBattleAt: state.last_battle_at || null,
      destroyedUntil: state.destroyed_until || null,
      avatarUrl: state.chat_avatar_file_id ? `/api/telegram/chat-photo?stateId=${encodeURIComponent(state.id)}` : null,
      shieldUntil: state.shield_until || null,
      nextAttackAt: state.next_attack_at || null,
    },
    buildings,
    tiles,
    wars: [],
    diplomacy,
    worldFeed,
    leaderboard,
    islands,
    dailyMissions,
    season,
    election,
    badges,
    activeBattle,
  };
}

export async function upgradeBuilding(stateId: string, buildingType: BuildingType) {
  const supabase = getSupabaseAdmin();
  await tickState(stateId);
  const { data: building, error } = await supabase
    .from("buildings")
    .select("level")
    .eq("state_id", stateId)
    .eq("building_type", buildingType)
    .single();
  if (error) throw error;
  if (building.level >= 12) throw new Error("Максимальный уровень здания достигнут.");

  const cost = scaleCost(buildingType, building.level + 1);
  const { error: rpcError } = await supabase.rpc("gw_upgrade_building", {
    p_state_id: stateId,
    p_building_type: buildingType,
    p_credits: cost.credits || 0,
    p_steel: cost.steel || 0,
    p_fuel: cost.fuel || 0,
    p_food: cost.food || 0,
    p_tech: cost.tech || 0,
  });
  if (rpcError) throw rpcError;
  return { ok: true };
}

