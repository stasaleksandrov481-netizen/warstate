import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getChat, getChatMember, getChatMemberCount } from "@/lib/telegram-bot";
import { findActiveBattleForState } from "@/lib/battle";
import { getDiplomacyForState, getLeaderboard, getWorldFeed, recordWorldEvent } from "@/lib/diplomacy";
import { getDailyMissions, recordMissionProgress } from "@/lib/missions";
import { ensureMilestoneBadges, getActiveSeason, getElection, getStateBadges } from "@/lib/politics";
import { getIslandWorld, syncStateChatMeta } from "@/lib/islands";
import type { BuildingType, BuildingView, GameSnapshot, WarView } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";
import { requireData } from "@/lib/invariants";
import { getRecruitmentHub } from "@/lib/recruitment";

const BUILDING_META: Record<BuildingType, { label: string; description: string; x: number; y: number }> = {
  hq: { label: "Штаб", description: "Рейтинг, оборона острова и лимиты государства", x: 50, y: 36 },
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


async function ensureStateBuildings(stateId: string) {
  const supabase = getSupabaseAdmin();
  const rows = (Object.keys(BUILDING_META) as BuildingType[]).map((building_type) => ({
    state_id: stateId,
    building_type,
    level: 1,
  }));
  const { error } = await supabase.from("buildings").upsert(rows, { onConflict: "state_id,building_type", ignoreDuplicates: true });
  if (error) throw error;
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
  return requireData(data, "Не удалось обновить состояние государства.");
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
  return requireData(data, "Не удалось создать профиль игрока.");
}

async function ensureStateForChat(chatId: number, playerId: string, telegramUserId: number) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: selectError } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).maybeSingle();
  if (selectError) throw selectError;
  if (existing) {
    await ensureStateBuildings(existing.id);
    return existing;
  }

  const member = await getChatMember(chatId, telegramUserId);
  if (member.status !== "administrator" && member.status !== "creator") {
    throw new Error("Государство ещё не создано. Первый запуск должен сделать администратор Telegram-группы.");
  }

  const [chat, memberCount] = await Promise.all([getChat(chatId), getChatMemberCount(chatId)]);
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
      const { data, error: refetchError } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).single();
      if (refetchError) throw refetchError;
      return requireData(data, "Государство не найдено после параллельного создания.");
    }
    throw error;
  }

  const createdState = requireData(created, "Не удалось создать государство.");

  await ensureStateBuildings(createdState.id);

  await recordWorldEvent({
    eventType: "state_founded",
    title: "Новое государство",
    body: `${createdState.name} появилось на мировой карте.`,
    actorStateId: createdState.id,
  });

  // v0.9+: a chat owns one island directly. The legacy hex map is no longer allocated.


  return createdState;
}

async function ensureFreeport() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("states").select("*").eq("is_freeport", true).single();
  if (error) throw new Error("Freeport не настроен. Выполните миграцию 011_freeport_live_recruitment.sql.");
  return requireData(data, "Freeport не найден.");
}

async function existingHomeState(playerId: string) {
  const supabase = getSupabaseAdmin();
  const { data: player, error } = await supabase.from("players").select("home_state_id").eq("id", playerId).single();
  if (error) throw error;
  if (!player?.home_state_id) return null;
  const { data: state, error: stateError } = await supabase.from("states").select("*").eq("id", player.home_state_id).maybeSingle();
  if (stateError) throw stateError;
  return state || null;
}

export async function bootstrapGame(user: TelegramUser, chatId: number | null): Promise<GameSnapshot> {
  const supabase = getSupabaseAdmin();
  const player = await upsertPlayer(user);

  let state: any;
  let role = "citizen";
  let membershipVerifiedAt: string | null = null;

  if (chatId) {
    const membership = await getChatMember(chatId, user.id);
    if (membership.status === "left" || membership.status === "kicked") throw new Error("Вы не состоите в этой Telegram-группе.");

    state = await ensureStateForChat(chatId, player.id, user.id);
    state = await syncStateChatMeta(state.id, chatId);

    // Migration 011 releases legacy ghost owners. The first real Telegram admin
    // who opens an ownerless state becomes its president using a conditional
    // update, so concurrent admin launches cannot create two owners.
    if (!state.owner_player_id && (membership.status === "administrator" || membership.status === "creator")) {
      const { data: claimed, error: claimError } = await supabase
        .from("states")
        .update({ owner_player_id: player.id })
        .eq("id", state.id)
        .is("owner_player_id", null)
        .select("*")
        .maybeSingle();
      if (claimError) throw claimError;
      if (claimed) state = claimed;
      else {
        const { data: currentState, error: currentStateError } = await supabase.from("states").select("*").eq("id", state.id).single();
        if (currentStateError) throw currentStateError;
        state = requireData(currentState, "Государство не найдено после назначения президента.");
      }
    }

    const home = await existingHomeState(player.id);
    if (home && !home.is_freeport && home.id !== state.id) {
      throw new Error(`Вы уже состоите в государстве «${home.name}». Переход между государствами появится отдельной механикой.`);
    }

    const { data: existingMember, error: existingMemberError } = await supabase
      .from("state_members")
      .select("role")
      .eq("state_id", state.id)
      .eq("player_id", player.id)
      .maybeSingle();
    if (existingMemberError) throw existingMemberError;
    role = state.owner_player_id === player.id
      ? "president"
      : membership.status === "administrator" || membership.status === "creator"
        ? (existingMember?.role === "general" ? "general" : "minister")
        : existingMember?.role === "general"
          ? "general"
          : "citizen";
    membershipVerifiedAt = new Date().toISOString();

  } else {
    const home = await existingHomeState(player.id);
    if (home && !home.is_freeport && home.telegram_chat_id) {
      const membership = await getChatMember(Number(home.telegram_chat_id), user.id);
      if (!["left", "kicked"].includes(membership.status)) {
        state = await syncStateChatMeta(home.id, Number(home.telegram_chat_id));
        const { data: existingMember, error: existingMemberError } = await supabase.from("state_members").select("role").eq("state_id", home.id).eq("player_id", player.id).maybeSingle();
        if (existingMemberError) throw existingMemberError;
        role = existingMember?.role || "citizen";
        membershipVerifiedAt = new Date().toISOString();
      } else {
        // The final gw_set_player_home_state call atomically moves this player
        // to Freeport and removes the stale Telegram-state membership.
        state = null;
      }
    }
    if (!state) {
      state = await ensureFreeport();
      role = "citizen";
    }
  }

  // One Telegram player has one active in-game citizenship. The database RPC
  // serializes concurrent launches and changes membership + home_state_id atomically.
  const { data: membershipId, error: memberError } = await supabase.rpc("gw_set_player_home_state", {
    p_player_id: player.id,
    p_state_id: state.id,
    p_role: role,
    p_membership_verified_at: membershipVerifiedAt,
  });
  if (memberError) {
    if (String(memberError.message || "").includes("gw_set_player_home_state") || memberError.code === "PGRST202") {
      throw new Error("Не установлена миграция 012_live_integrity_audit.sql.");
    }
    throw memberError;
  }
  if (!membershipId) throw new Error("Не удалось сохранить гражданство игрока.");
  if (!state.is_freeport) state = await tickState(state.id);
  await recordMissionProgress(player.id, state.id, "check_in");
  return getGameSnapshot(player.id, state.id, user.id, role);
}


async function getRecentIslandWars(stateId: string, limit = 8): Promise<WarView[]> {
  const supabase = getSupabaseAdmin();
  const { data: battles, error } = await supabase
    .from("battles")
    .select("id,attacker_state_id,defender_state_id,tile_id,attacker_score,defender_score,status,winner_state_id,created_at")
    .eq("battle_kind", "island")
    .or(`attacker_state_id.eq.${stateId},defender_state_id.eq.${stateId}`)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(20, limit)));
  if (error) throw error;

  const rows = battles || [];
  if (!rows.length) return [];
  const stateIds = [...new Set(rows.flatMap((row: any) => [row.attacker_state_id, row.defender_state_id]).filter(Boolean))];
  const { data: states, error: statesError } = await supabase.from("states").select("id,name").in("id", stateIds);
  if (statesError) throw statesError;
  const names = new Map((states || []).map((row: any) => [String(row.id), String(row.name)]));

  return rows.map((row: any) => ({
    id: String(row.id),
    attackerName: names.get(String(row.attacker_state_id)) || "Государство",
    defenderName: row.defender_state_id ? names.get(String(row.defender_state_id)) || "Государство" : null,
    tileId: row.tile_id || null,
    winnerStateId: row.winner_state_id || null,
    attackerPower: Math.max(0, Number(row.attacker_score || 0)),
    defenderPower: Math.max(0, Number(row.defender_score || 0)),
    status: String(row.status || "resolved"),
    createdAt: String(row.created_at),
  }));
}

export async function getGameSnapshot(
  playerId: string,
  stateId: string,
  telegramId: number,
  role: string,
): Promise<GameSnapshot> {
  const supabase = getSupabaseAdmin();
  const [playerRes, stateRes, buildingsRes, membersRes, myMemberRes] = await Promise.all([
    supabase.from("players").select("id,display_name,username,level,xp,energy").eq("id", playerId).single(),
    supabase.from("states").select("id,name,color,motto,emblem,theme,telegram_chat_id,credits,steel,fuel,food,tech,rating,rating_peak,telegram_member_count,world_x,world_y,island_wins,island_losses,destroyed_until,chat_avatar_file_id,shield_until,next_attack_at,island_integrity,win_streak,best_win_streak,last_battle_at,is_freeport").eq("id", stateId).single(),
    supabase.from("buildings").select("building_type,level").eq("state_id", stateId).order("building_type"),
    supabase.from("state_members").select("id", { count: "exact", head: true }).eq("state_id", stateId),
    supabase.from("state_members").select("contribution").eq("state_id", stateId).eq("player_id", playerId).single(),
  ]);
  for (const response of [playerRes, stateRes, buildingsRes, membersRes, myMemberRes]) {
    if (response.error) throw response.error;
  }

  const player = playerRes.data;
  const state = stateRes.data;
  if (!player) throw new Error("Игрок не найден.");
  if (!state) throw new Error("Государство не найдено.");

  const buildingsRaw = (buildingsRes.data || []) as Array<{ building_type: BuildingType; level: number }>;
  const rates = state.is_freeport ? { credits: 0, steel: 0, fuel: 0, food: 0, tech: 0 } : production(buildingsRaw);
  // Island World no longer ships the legacy 127-hex map in every snapshot.
  const wins = state.island_wins || 0;
  const rankPromise = state.is_freeport
    ? null
    : supabase.from("states").select("id", { count: "exact", head: true }).eq("is_freeport", false).gt("rating", state.rating);
  const electionPromise = state.is_freeport ? null : getElection(stateId, playerId);

  const [rankRes, diplomacy, worldFeed, leaderboard, dailyMissions, activeBattle, season, election, recruitment, recentWars] = await Promise.all([
    rankPromise,
    getDiplomacyForState(stateId),
    getWorldFeed(24),
    getLeaderboard(10),
    getDailyMissions(playerId, stateId, Boolean(state.is_freeport)),
    findActiveBattleForState(stateId, playerId),
    getActiveSeason(),
    electionPromise,
    getRecruitmentHub(playerId, stateId, Boolean(state.is_freeport), role),
    state.is_freeport ? Promise.resolve([] as WarView[]) : getRecentIslandWars(stateId),
  ]);
  const islands = await getIslandWorld(stateId, diplomacy, { x: Number(state.world_x || 0), y: Number(state.world_y || 0) });
  if (rankRes?.error) throw rankRes.error;
  if (!state.is_freeport) {
    await ensureMilestoneBadges(stateId, season?.id || null, state.rating, wins, state.best_win_streak || 0);
  }
  const badges = state.is_freeport ? [] : await getStateBadges(stateId);

  const buildings: BuildingView[] = buildingsRaw.map((b) => ({
    type: b.building_type,
    level: b.level,
    upgradeCost: scaleCost(b.building_type, b.level + 1),
    ...BUILDING_META[b.building_type],
  }));

  return {
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
      telegramChatId: state.is_freeport ? null : Number(state.telegram_chat_id),
      isFreeport: Boolean(state.is_freeport),
      treasury: {
        credits: state.credits,
        steel: state.steel,
        fuel: state.fuel,
        food: state.food,
        tech: state.tech,
      },
      productionPerHour: rates,
      rating: state.rating,
      memberCount: state.is_freeport ? (membersRes.count || state.telegram_member_count || 1) : (state.telegram_member_count || membersRes.count || 1),
      seasonRank: state.is_freeport ? 0 : (rankRes?.count || 0) + 1,
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
    wars: recentWars,
    diplomacy,
    worldFeed,
    leaderboard,
    islands,
    dailyMissions,
    season,
    election,
    badges,
    activeBattle,
    recruitment,
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
  const buildingRow = requireData(building, "Здание не найдено.");
  if (buildingRow.level >= 12) throw new Error("Максимальный уровень здания достигнут.");

  const cost = scaleCost(buildingType, buildingRow.level + 1);
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

