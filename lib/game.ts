import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertTelegramChatMembership, TelegramMembershipRequiredError } from "@/lib/telegram-bot";
import { findActiveBattleForState } from "@/lib/battle";
import { getDiplomacyForState, getLeaderboard, getWorldFeed, recordWorldEvent } from "@/lib/diplomacy";
import { getDailyMissions, recordMissionProgress } from "@/lib/missions";
import { ensureMilestoneBadges, getActiveSeason, getElection, getStateBadges } from "@/lib/politics";
import { getIslandWorld, syncStateChatMeta } from "@/lib/islands";
import type { BuildingType, BuildingView, GameSnapshot, WarView } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";
import { requireData } from "@/lib/invariants";
import { getRecruitmentHub } from "@/lib/recruitment";
import { getStrategyView } from "@/lib/strategy";
import { getGovernmentView, registerTelegramState } from "@/lib/government";
import { reconcileStateRuntime } from "@/lib/maintenance";
import { applyWorkforceBonus, isMissingDutyRoleError } from "@/lib/community";

const BUILDING_META: Record<BuildingType, { label: string; description: string; x: number; y: number }> = {
  hq: { label: "Казначейство и штаб", description: "Бюджет, управление, оборона и уровень государства", x: 50, y: 36 },
  barracks: { label: "Казармы", description: "Повышают силу атакующей армии", x: 31, y: 53 },
  mine: { label: "Шахта", description: "Производит сталь", x: 69, y: 56 },
  refinery: { label: "НПЗ", description: "Производит топливо", x: 76, y: 30 },
  farm: { label: "Ферма", description: "Производит продовольствие", x: 22, y: 27 },
  lab: { label: "Академия", description: "Производит технологии и усиливает стратегические ветки", x: 52, y: 67 },
  outpost: { label: "Застава", description: "Усиливает оборону и Defensive Buffer", x: 15, y: 47 },
  trade_chamber: { label: "Торговая палата", description: "Усиливает бюджет, торговлю и дипломатическое влияние", x: 84, y: 47 },
};

function warnOptionalSnapshotPart(label: string, error: unknown) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message || "unknown error")
      : String(error || "unknown error");
  console.warn(`WARSTATE snapshot optional part skipped: ${label}: ${message}`);
}

async function optionalSnapshotPart<T>(label: string, fallback: T, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    warnOptionalSnapshotPart(label, error);
    return fallback;
  }
}

function emptyStrategy(role: string, beginnerIsland: boolean) {
  return {
    activities: [],
    completedToday: 0,
    contributionEvents: [],
    supportableBattles: [],
    canManage: ["president", "minister", "deputy", "curator"].includes(role),
    canCommand: ["president", "minister", "deputy", "curator"].includes(role),
    rules: {
      maxDailyActivities: beginnerIsland ? 3 : 4,
      maxAttackSizePenalty: 0.30,
      maxUnderdogBonus: 0.25,
      maxAggressionPenalty: 0.15,
      maxAllianceSupport: 0.35,
      raidLootBudgetPct: 0.20,
      raidLootInfluencePct: 0.15,
    },
  };
}

const EMPTY_RECRUITMENT = { post: null, listings: [], myRequests: [], incoming: [], freeAgents: [] };
const EMPTY_GOVERNMENT = { stateUsername: null, telegramChatTitle: null, founder: null, president: null, deputies: [], canFounderManage: false, canProjectAdmin: false };

const BASE_COSTS: Record<BuildingType, Partial<Record<"credits" | "steel" | "fuel" | "food" | "tech", number>>> = {
  hq: { credits: 1800, steel: 500, tech: 30 },
  barracks: { credits: 1200, steel: 420, food: 220 },
  mine: { credits: 900, steel: 180 },
  refinery: { credits: 1100, steel: 220 },
  farm: { credits: 700, steel: 100 },
  lab: { credits: 1500, steel: 300, tech: 20 },
  outpost: { credits: 1350, steel: 460, food: 120, tech: 12 },
  trade_chamber: { credits: 1450, steel: 180, food: 160, tech: 24 },
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
    credits: 320 + (levels.hq || 1) * 95 + (levels.trade_chamber || 0) * 55,
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
  const { error: finishUpgradeError } = await supabase.rpc("gw_finish_building_upgrades", { p_state_id: stateId });
  if (finishUpgradeError) throw finishUpgradeError;
  const [{ data: buildings, error: buildingsError }, { data: state, error: stateError }] = await Promise.all([
    supabase.from("buildings").select("building_type, level").eq("state_id", stateId),
    supabase.from("states").select("is_beginner_island").eq("id", stateId).single(),
  ]);
  if (buildingsError) throw buildingsError;
  if (stateError) throw stateError;

  const rawRates = production((buildings || []) as Array<{ building_type: BuildingType; level: number }>);
  const incomeFactor = state?.is_beginner_island ? 0.60 : 1;
  const baseAdjusted = Object.fromEntries(Object.entries(rawRates).map(([key, value]) => [key, Math.round(value * incomeFactor)])) as typeof rawRates;
  const rates = await applyWorkforceBonus(stateId, baseAdjusted);
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

function isConfiguredBeginnerChat(chatId: number) {
  const configured = String(process.env.BEGINNER_ISLAND_CHAT_ID || "").trim();
  return configured.length > 0 && Number(configured) === chatId;
}

async function ensureStateForChat(chatId: number, _playerId: string, _telegramUserId: number) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: selectError } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).maybeSingle();
  if (selectError) throw selectError;

  let current = existing;
  // v1.9: a state is registered from the real Telegram chat owner, not from
  // whichever administrator happens to open Mini App first. Legacy states are
  // also owner-verified the first time they are opened after migration 014.
  if (!current || !current.founder_player_id || !current.telegram_chat_title) {
    current = await registerTelegramState(chatId);
  }

  if (isConfiguredBeginnerChat(chatId) && !current.is_beginner_island) {
    const { data: protectedState, error: protectError } = await supabase
      .from("states")
      .update({ is_beginner_island: true, max_level: 5, owner_player_id: null })
      .eq("id", current.id)
      .select("*")
      .single();
    if (protectError) throw protectError;
    current = requireData(protectedState, "Не удалось включить Остров новичков.");
  }

  await ensureStateBuildings(current.id);
  return current;
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


function isMissingPresenceTable(error: any) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || message.includes("telegram_chat_members");
}

export async function markTelegramGroupMemberLeft(chatId: number, telegramId: number) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("telegram_chat_members")
    .upsert({
      telegram_chat_id: chatId,
      telegram_id: telegramId,
      status: "left",
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "telegram_chat_id,telegram_id" });
  if (error && !isMissingPresenceTable(error)) throw error;
}

export async function observeTelegramGroupMember(user: TelegramUser, chatId: number) {
  const supabase = getSupabaseAdmin();
  const player = await upsertPlayer(user);
  const state = await ensureStateForChat(chatId, player.id, user.id);

  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || String(user.id);
  const { error: presenceError } = await supabase.from("telegram_chat_members").upsert({
    telegram_chat_id: chatId,
    telegram_id: user.id,
    username: user.username || null,
    display_name: displayName,
    status: "member",
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "telegram_chat_id,telegram_id" });
  if (presenceError && !isMissingPresenceTable(presenceError)) throw presenceError;

  const { data: playerHome, error: playerHomeError } = await supabase
    .from("players")
    .select("home_state_id")
    .eq("id", player.id)
    .single();
  if (playerHomeError) throw playerHomeError;

  const { data: existingMember, error: memberError } = await supabase
    .from("state_members")
    .select("id,role,state_id")
    .eq("player_id", player.id)
    .maybeSingle();
  if (memberError) throw memberError;

  // If the player already has a normal home elsewhere, merely seeing them in
  // another Telegram group must never steal their citizenship. !вступить remains
  // the explicit transition path and database transition rules stay authoritative.
  if (playerHome?.home_state_id && String(playerHome.home_state_id) !== String(state.id)) {
    const home = await existingHomeState(player.id);
    if (home && !home.is_freeport && !home.is_beginner_island) {
      return { playerId: player.id, stateId: state.id, enrolled: false, reason: "other_home" as const };
    }
  }

  const desiredRole = String(state.founder_player_id || "") === String(player.id)
    ? "citizen"
    : (existingMember && String(existingMember.state_id) === String(state.id) ? String(existingMember.role || "citizen") : "citizen");

  const { error: enrollError } = await supabase.rpc("gw_set_player_home_state", {
    p_player_id: player.id,
    p_state_id: state.id,
    p_role: desiredRole,
    p_membership_verified_at: new Date().toISOString(),
  });
  if (enrollError) {
    // Old database revisions used INSERT ... ON CONFLICT(state_id,player_id),
    // which can still collide with uq_state_members_one_home on a repeated sync.
    // Treat an already-correct membership as success so webhook delivery never
    // becomes a 500 loop while migration 027 is being applied.
    if (String(enrollError.code || "") === "23505") {
      const { data: current, error: currentError } = await supabase
        .from("state_members")
        .select("state_id,role")
        .eq("player_id", player.id)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current || String(current.state_id) !== String(state.id)) {
        return { playerId: player.id, stateId: state.id, enrolled: false, reason: "other_home" as const };
      }
    } else {
      throw enrollError;
    }
  }

  if (String(state.founder_player_id || "") === String(player.id)) {
    const { error: founderRoleError } = await supabase
      .from("state_members")
      .update({ role: "founder" })
      .eq("state_id", state.id)
      .eq("player_id", player.id)
      .neq("role", "president");
    if (founderRoleError) throw founderRoleError;
  }

  return { playerId: player.id, stateId: state.id, enrolled: true, reason: "enrolled" as const };
}

async function getPlayerMemberSnapshot(stateId: string, playerId: string) {
  const supabase = getSupabaseAdmin();
  const rich = await supabase
    .from("state_members")
    .select("contribution,duty_role")
    .eq("state_id", stateId)
    .eq("player_id", playerId)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!rich.error) return { contribution: Number(rich.data?.contribution || 0), dutyRole: rich.data?.duty_role || null };
  if (!isMissingDutyRoleError(rich.error)) throw rich.error;

  // Backward-compatible bootstrap for rolling database migrations. The Mini App
  // stays usable and simply shows no duty specialization until duty_role exists.
  const fallback = await supabase
    .from("state_members")
    .select("contribution")
    .eq("state_id", stateId)
    .eq("player_id", playerId)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (fallback.error) throw fallback.error;
  return { contribution: Number(fallback.data?.contribution || 0), dutyRole: null };
}

export async function bootstrapGame(user: TelegramUser, chatId: number | null, options: { preserveHomeState?: boolean; syntheticRole?: string } = {}): Promise<GameSnapshot> {
  const supabase = getSupabaseAdmin();
  const player = await upsertPlayer(user);

  let state: any;
  let role = "citizen";
  let membershipVerifiedAt: string | null = null;

  if (chatId) {
    await assertTelegramChatMembership(chatId, user.id, [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Игрок");

    state = await ensureStateForChat(chatId, player.id, user.id);
    state = await syncStateChatMeta(state.id, chatId);

    const home = await existingHomeState(player.id);

    const { data: existingMember, error: existingMemberError } = await supabase
      .from("state_members")
      .select("role")
      .eq("state_id", state.id)
      .eq("player_id", player.id)
      .maybeSingle();
    if (existingMemberError) throw existingMemberError;
    role = state.is_beginner_island
      ? (existingMember?.role === "curator" ? "curator" : "citizen")
      : existingMember?.role || (state.founder_player_id === player.id ? "founder" : "citizen");
    membershipVerifiedAt = new Date().toISOString();

  } else {
    const home = await existingHomeState(player.id);
    if (home && !home.is_freeport && home.telegram_chat_id) {
      try {
        await assertTelegramChatMembership(Number(home.telegram_chat_id), user.id, [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Игрок", { sendInvite: false });
        state = await syncStateChatMeta(home.id, Number(home.telegram_chat_id));
        const { data: existingMember, error: existingMemberError } = await supabase.from("state_members").select("role").eq("state_id", home.id).eq("player_id", player.id).maybeSingle();
        if (existingMemberError) throw existingMemberError;
        role = existingMember?.role || "citizen";
        membershipVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (!(error instanceof TelegramMembershipRequiredError)) throw error;
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

  // One Telegram player normally has one active in-game citizenship. Project
  // superadmins may inspect/control any group without moving their real home state.
  // This prevents the creator from accidentally "joining" every state they help.
  if (!options.preserveHomeState) {
    const { error: memberError } = await supabase.rpc("gw_set_player_home_state", {
      p_player_id: player.id,
      p_state_id: state.id,
      p_role: role === "founder" ? "citizen" : role,
      p_membership_verified_at: membershipVerifiedAt,
    });
    if (memberError) {
      const dbMessage = String(memberError.message || "");
      if (dbMessage.includes("24") || dbMessage.toLowerCase().includes("cooldown")) {
        console.warn("Ignored citizenship cooldown during bootstrap:", dbMessage);
      } else if (dbMessage.includes("gw_set_player_home_state") || memberError.code === "PGRST202") {
        throw new Error("Не установлены актуальные миграции 012_live_integrity_audit.sql и 013_full_state_wars_spec.sql.");
      } else {
        throw memberError;
      }
    }
    if (role === "founder") {
      const { error: restoreFounderError } = await supabase.from("state_members").update({ role: "founder" }).eq("state_id", state.id).eq("player_id", player.id);
      if (restoreFounderError) throw restoreFounderError;
    }
  }
  // Project admins never become in-game presidents. Their power is checked separately.\n  // Keep the real government role from Telegram state unchanged.
  if (state.is_beginner_island) {
    const { error: curatorError } = await supabase.rpc("gw_refresh_beginner_curator", { p_state_id: state.id });
    if (curatorError && curatorError.code !== "PGRST202") throw curatorError;
    const { data: refreshedMember, error: refreshedMemberError } = await supabase
      .from("state_members")
      .select("role")
      .eq("state_id", state.id)
      .eq("player_id", player.id)
      .single();
    if (refreshedMemberError) throw refreshedMemberError;
    role = refreshedMember?.role || "citizen";
  }
  if (!state.is_freeport) {
    // Event-driven maintenance replaces the old mandatory Vercel Cron jobs.
    // The DB lease makes this cheap when many players open the same state.
    await reconcileStateRuntime(state.id);
    state = await tickState(state.id);
  }
  await recordMissionProgress(player.id, state.id, "check_in").catch((error) => warnOptionalSnapshotPart("mission check-in", error));
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
  const { error: finishUpgradeError } = await supabase.rpc("gw_finish_building_upgrades", { p_state_id: stateId });
  if (finishUpgradeError && finishUpgradeError.code !== "PGRST202") throw finishUpgradeError;
  if (finishUpgradeError) warnOptionalSnapshotPart("finish building upgrades", finishUpgradeError);
  const { error: strategyRefreshError } = await supabase.rpc("gw_refresh_state_strategy", { p_state_id: stateId });
  if (strategyRefreshError && strategyRefreshError.code !== "PGRST202") throw strategyRefreshError;
  const [playerRes, stateRes, buildingsRes, membersRes, myMember] = await Promise.all([
    supabase.from("players").select("id,display_name,username,level,xp,energy").eq("id", playerId).single(),
    supabase.from("states").select("id,name,state_username,telegram_chat_title,color,motto,emblem,theme,telegram_chat_id,credits,steel,fuel,food,tech,rating,rating_peak,telegram_member_count,world_x,world_y,island_wins,island_losses,destroyed_until,chat_avatar_file_id,shield_until,next_attack_at,island_integrity,win_streak,best_win_streak,last_battle_at,is_freeport,is_beginner_island,game_level,max_level,influence,reputation,army_power,defense_power,active_player_count,state_size").eq("id", stateId).single(),
    supabase.from("buildings").select("building_type,level,upgrade_target_level,upgrade_started_at,upgrade_finishes_at,upgrade_cooldown_until").eq("state_id", stateId).order("building_type"),
    supabase.from("state_members").select("id", { count: "exact", head: true }).eq("state_id", stateId),
    getPlayerMemberSnapshot(stateId, playerId),
  ]);
  for (const response of [playerRes, stateRes, buildingsRes, membersRes]) {
    if (response.error) throw response.error;
  }

  const player = playerRes.data;
  const state = stateRes.data;
  if (!player) throw new Error("Игрок не найден.");
  if (!state) throw new Error("Государство не найдено.");

  const buildingsRaw = (buildingsRes.data || []) as Array<{ building_type: BuildingType; level: number; upgrade_target_level?: number | null; upgrade_started_at?: string | null; upgrade_finishes_at?: string | null; upgrade_cooldown_until?: string | null }>;
  const baseRates = production(buildingsRaw);
  const beginnerIncomeFactor = state.is_beginner_island ? 0.60 : 1;
  const baseAdjustedRates = Object.fromEntries(Object.entries(baseRates).map(([key, value]) => [key, Math.round(value * beginnerIncomeFactor)])) as typeof baseRates;
  const rates = state.is_freeport ? { credits: 0, steel: 0, fuel: 0, food: 0, tech: 0 } : await applyWorkforceBonus(stateId, baseAdjustedRates);
  // Island World no longer ships the legacy 127-hex map in every snapshot.
  const wins = state.island_wins || 0;
  const rankPromise = state.is_freeport
    ? null
    : supabase.from("states").select("id", { count: "exact", head: true }).eq("is_freeport", false).gt("rating", state.rating);
  const electionPromise = state.is_freeport ? null : getElection(stateId, playerId);

  const diplomacy = await optionalSnapshotPart("diplomacy", [], () => getDiplomacyForState(stateId));
  const [rankRes, worldFeed, leaderboard, dailyMissions, activeBattle, season, election, recruitment, recentWars, strategy, government] = await Promise.all([
    rankPromise,
    optionalSnapshotPart("world feed", [], () => getWorldFeed(24)),
    optionalSnapshotPart("leaderboard", [], () => getLeaderboard(10)),
    optionalSnapshotPart("daily missions", [], () => getDailyMissions(playerId, stateId, Boolean(state.is_freeport))),
    optionalSnapshotPart("active battle", null, () => findActiveBattleForState(stateId, playerId)),
    optionalSnapshotPart("season", null, () => getActiveSeason()),
    electionPromise ? optionalSnapshotPart("election", null, () => electionPromise) : Promise.resolve(null),
    optionalSnapshotPart("recruitment", EMPTY_RECRUITMENT, () => getRecruitmentHub(playerId, stateId, Boolean(state.is_freeport), role)),
    state.is_freeport ? Promise.resolve([] as WarView[]) : optionalSnapshotPart("recent wars", [] as WarView[], () => getRecentIslandWars(stateId)),
    optionalSnapshotPart("strategy", emptyStrategy(role, Boolean(state.is_beginner_island)), () => getStrategyView(playerId, stateId, role, Boolean(state.is_beginner_island))),
    optionalSnapshotPart("government", EMPTY_GOVERNMENT, () => getGovernmentView(stateId, playerId)),
  ]);
  const islands = await optionalSnapshotPart("island world", [], () => getIslandWorld(stateId, diplomacy, { x: Number(state.world_x || 0), y: Number(state.world_y || 0) }));
  if (rankRes?.error) warnOptionalSnapshotPart("season rank", rankRes.error);
  if (!state.is_freeport) {
    await ensureMilestoneBadges(stateId, season?.id || null, state.rating, wins, state.best_win_streak || 0)
      .catch((error) => warnOptionalSnapshotPart("milestone badges", error));
  }
  const badges = state.is_freeport ? [] : await optionalSnapshotPart("state badges", [], () => getStateBadges(stateId));

  const buildings: BuildingView[] = buildingsRaw.map((b) => ({
    type: b.building_type,
    level: b.level,
    upgradeTargetLevel: b.upgrade_target_level || null,
    upgradeStartedAt: b.upgrade_started_at || null,
    upgradeFinishesAt: b.upgrade_finishes_at || null,
    upgradeCooldownUntil: b.upgrade_cooldown_until || null,
    upgradeCost: Object.fromEntries(Object.entries(scaleCost(b.building_type, b.level + 1)).map(([key, value]) => [key, state.is_beginner_island ? Math.max(1, Math.round((value || 0) * 0.60)) : value])),
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
      contribution: myMember.contribution,
      role,
      dutyRole: myMember.dutyRole,
    },
    state: {
      id: state.id,
      name: state.name,
      stateUsername: state.state_username || null,
      telegramChatTitle: state.telegram_chat_title || null,
      color: state.color,
      motto: state.motto || "Сила в единстве",
      emblem: state.emblem || "◆",
      theme: state.theme || "violet",
      telegramChatId: state.is_freeport ? null : Number(state.telegram_chat_id),
      isFreeport: Boolean(state.is_freeport),
      isBeginnerIsland: Boolean(state.is_beginner_island),
      level: Number(state.game_level || 1),
      maxLevel: Number(state.max_level || 50),
      influence: Number(state.influence || 0),
      reputation: Number(state.reputation || 0),
      armyPower: Number(state.army_power || 100),
      defensePower: Number(state.defense_power || 100),
      activePlayers: Math.max(1, Number(state.active_player_count || 1)),
      stateSize: Math.max(0.0001, Number(state.state_size || 1)),
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
    strategy,
    government,
  };
}

export async function upgradeBuilding(stateId: string, buildingType: BuildingType) {
  const supabase = getSupabaseAdmin();
  await tickState(stateId);
  const [{ data: building, error }, { data: state, error: stateError }] = await Promise.all([
    supabase.from("buildings").select("level,upgrade_target_level,upgrade_finishes_at,upgrade_cooldown_until").eq("state_id", stateId).eq("building_type", buildingType).single(),
    supabase.from("states").select("is_beginner_island,max_level").eq("id", stateId).single(),
  ]);
  if (error) throw error;
  if (stateError) throw stateError;
  const buildingRow = requireData(building, "Здание не найдено.");
  const maxBuildingLevel = state?.is_beginner_island ? Math.min(5, Number(state.max_level || 5)) : 12;
  if (buildingRow.upgrade_target_level && buildingRow.upgrade_finishes_at && new Date(buildingRow.upgrade_finishes_at).getTime() > Date.now()) throw new Error("Это здание уже улучшается.");
  if (buildingRow.upgrade_cooldown_until && new Date(buildingRow.upgrade_cooldown_until).getTime() > Date.now()) throw new Error("Здание ещё остывает после предыдущего улучшения.");
  if (buildingRow.level >= maxBuildingLevel) throw new Error(state?.is_beginner_island ? "На Острове новичков постройки ограничены 5 уровнем." : "Максимальный уровень здания достигнут.");
  if (state?.is_beginner_island && buildingType === "barracks") throw new Error("На Острове новичков агрессивные улучшения казарм запрещены.");

  const rawCost = scaleCost(buildingType, buildingRow.level + 1);
  const cost = Object.fromEntries(Object.entries(rawCost).map(([key, value]) => [key, state?.is_beginner_island ? Math.max(1, Math.round((value || 0) * 0.60)) : value]));
  const { data: targetLevel, error: rpcError } = await supabase.rpc("gw_upgrade_building", {
    p_state_id: stateId,
    p_building_type: buildingType,
    p_credits: cost.credits || 0,
    p_steel: cost.steel || 0,
    p_fuel: cost.fuel || 0,
    p_food: cost.food || 0,
    p_tech: cost.tech || 0,
  });
  if (rpcError) throw rpcError;
  const { data: upgraded, error: upgradedError } = await supabase.from("buildings")
    .select("upgrade_target_level,upgrade_finishes_at,upgrade_cooldown_until")
    .eq("state_id", stateId).eq("building_type", buildingType).single();
  if (upgradedError) throw upgradedError;
  return { ok: true, targetLevel: Number(targetLevel || upgraded?.upgrade_target_level || buildingRow.level + 1), finishesAt: upgraded?.upgrade_finishes_at || null };
}

