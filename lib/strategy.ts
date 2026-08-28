import { createHash } from "node:crypto";
import { resolveBattleByScore, tickBattle } from "@/lib/battle";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { enforceRateLimit, withActionLock } from "@/lib/redis";
import type { ActivityOptionView, ActivityView, StrategyView, WarType } from "@/lib/types";

const MANAGERS = new Set(["president", "minister", "deputy", "curator"]);
const COMMANDERS = new Set(["president", "minister", "deputy", "curator"]);

function asNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function utcDayStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function mapOption(raw: any, beginnerIsland = false): ActivityOptionView {
  return {
    key: String(raw?.key || ""),
    label: String(raw?.label || raw?.key || "Вариант"),
    risk: Math.max(0, Math.min(beginnerIsland ? 0.08 : 1, asNumber(raw?.risk))),
    rewards: {
      credits: Math.max(0, Math.round(asNumber(raw?.credits))),
      influence: Math.max(0, Math.round(asNumber(raw?.influence))),
      tech: Math.max(0, Math.round(asNumber(raw?.tech))),
      reputation: Math.round(asNumber(raw?.reputation)),
      contribution: Math.max(0, Math.round(asNumber(raw?.contribution))),
    },
  };
}

export async function getStrategyView(playerId: string, stateId: string, role: string, beginnerIsland: boolean): Promise<StrategyView> {
  const supabase = getSupabaseAdmin();
  const dayStart = utcDayStart();
  const [templatesRes, runsRes, contributionsRes] = await Promise.all([
    supabase.from("activity_templates").select("key,title,description,beginner_allowed,options").eq("active", true).order("created_at"),
    supabase.from("player_activity_runs").select("activity_key").eq("player_id", playerId).gte("completed_at", dayStart),
    supabase.from("contribution_events").select("id,source,amount,created_at").eq("player_id", playerId).eq("state_id", stateId).order("created_at", { ascending: false }).limit(12),
  ]);
  if (templatesRes.error) throw new Error("Не установлена миграция 013_full_state_wars_spec.sql.");
  if (runsRes.error) throw runsRes.error;
  if (contributionsRes.error) throw contributionsRes.error;

  const completed = new Set((runsRes.data || []).map((row: any) => String(row.activity_key)));
  const dayKey = new Date().toISOString().slice(0, 10);
  const dailyLimit = beginnerIsland ? 3 : 4;
  const activities: ActivityView[] = (templatesRes.data || [])
    .filter((row: any) => !beginnerIsland || Boolean(row.beginner_allowed))
    .sort((a: any, b: any) => {
      const ah = createHash("md5").update(`${String(a.key)}:${playerId}:${dayKey}`).digest("hex");
      const bh = createHash("md5").update(`${String(b.key)}:${playerId}:${dayKey}`).digest("hex");
      return ah.localeCompare(bh);
    })
    .slice(0, dailyLimit)
    .map((row: any) => ({
      key: String(row.key),
      title: String(row.title),
      description: beginnerIsland ? `${String(row.description)} Подсказка: в учебном государстве риск снижен.` : String(row.description),
      beginnerAllowed: Boolean(row.beginner_allowed),
      completed: completed.has(String(row.key)),
      options: Array.isArray(row.options) ? row.options.map((option: any) => mapOption(option, beginnerIsland)) : [],
    }));

  const { data: relations, error: relationsError } = await supabase
    .from("diplomacy_relations")
    .select("state_a_id,state_b_id")
    .eq("status", "allied")
    .or(`state_a_id.eq.${stateId},state_b_id.eq.${stateId}`);
  if (relationsError) throw relationsError;
  const allyIds = (relations || []).map((row: any) => String(row.state_a_id) === stateId ? String(row.state_b_id) : String(row.state_a_id));
  let supportableBattles: StrategyView["supportableBattles"] = [];
  if (allyIds.length) {
    const { data: battles, error: battleError } = await supabase
      .from("battles")
      .select("id,attacker_state_id,defender_state_id,battle_type,ends_at,attacker:states!battles_attacker_state_id_fkey(name),defender:states!battles_defender_state_id_fkey(name)")
      .in("status", ["scheduled", "active"])
      .or(`attacker_state_id.in.(${allyIds.join(",")}),defender_state_id.in.(${allyIds.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(8);
    if (battleError) throw battleError;
    supportableBattles = (battles || []).flatMap((battle: any) => {
      const attackerIsAlly = allyIds.includes(String(battle.attacker_state_id));
      const defenderIsAlly = allyIds.includes(String(battle.defender_state_id));
      if (!attackerIsAlly && !defenderIsAlly) return [];
      const side = attackerIsAlly ? "attacker" as const : "defender" as const;
      const allyStateId = String(attackerIsAlly ? battle.attacker_state_id : battle.defender_state_id);
      return [{
        id: String(battle.id),
        side,
        allyStateId,
        allyName: String(attackerIsAlly ? battle.attacker?.name || "Союзник" : battle.defender?.name || "Союзник"),
        enemyName: String(attackerIsAlly ? battle.defender?.name || "Противник" : battle.attacker?.name || "Противник"),
        battleType: (["raid", "siege", "territory"].includes(String(battle.battle_type)) ? battle.battle_type : "raid") as WarType,
        endsAt: String(battle.ends_at),
      }];
    });
  }

  return {
    activities,
    completedToday: completed.size,
    contributionEvents: (contributionsRes.data || []).map((row: any) => ({
      id: Number(row.id),
      source: String(row.source),
      amount: Number(row.amount || 0),
      createdAt: String(row.created_at),
    })),
    supportableBattles,
    canManage: MANAGERS.has(role),
    canCommand: COMMANDERS.has(role),
    rules: {
      maxDailyActivities: dailyLimit,
      maxAttackSizePenalty: 0.30,
      maxUnderdogBonus: 0.25,
      maxAggressionPenalty: 0.15,
      maxAllianceSupport: 0.35,
      raidLootBudgetPct: 0.20,
      raidLootInfluencePct: 0.15,
    },
  };
}

export async function completeDailyActivity(playerId: string, stateId: string, activityKey: string, optionKey: string) {
  if (!activityKey || !optionKey) throw new Error("Выберите активность и вариант действия.");
  await enforceRateLimit(`activity:${playerId}`, 12, 60);
  return withActionLock(`activity:${playerId}`, 8, async () => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("gw_complete_activity", {
      p_player_id: playerId,
      p_state_id: stateId,
      p_activity_key: activityKey,
      p_option_key: optionKey,
    });
    if (error) throw error;
    return data;
  });
}

export async function addAllianceBattleSupport(battleId: string, stateId: string, playerId: string, side: "attacker" | "defender") {
  await enforceRateLimit(`support:${stateId}`, 8, 60);
  await tickBattle(battleId);
  return withActionLock(`support:${battleId}:${stateId}`, 8, async () => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("gw_add_battle_support", {
      p_battle_id: battleId,
      p_support_state_id: stateId,
      p_player_id: playerId,
      p_side: side,
    });
    if (error) throw error;
    return data;
  });
}

export async function setBattleType(battleId: string, type: WarType) {
  const allowed: WarType[] = ["raid", "siege", "territory"];
  if (!allowed.includes(type)) throw new Error("Тип войны: raid, siege или territory.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("battles").update({ battle_type: type }).eq("id", battleId).in("status", ["scheduled", "active"]);
  if (error) throw error;
}

export async function surrenderBattle(battleId: string, stateId: string) {
  await enforceRateLimit(`surrender:${stateId}`, 4, 60);
  return withActionLock(`surrender:${battleId}`, 30, async () => {
    const supabase = getSupabaseAdmin();
    const { data: battle, error } = await supabase
      .from("battles")
      .select("id,attacker_state_id,defender_state_id,attacker_score,defender_score,status")
      .eq("id", battleId)
      .single();
    if (error) throw error;
    if (!battle || ![battle.attacker_state_id, battle.defender_state_id].includes(stateId)) {
      throw new Error("Ваше государство не участвует в этой битве.");
    }
    if (!["scheduled", "active"].includes(String(battle.status))) throw new Error("Битва уже завершена.");

    const attackerSurrenders = battle.attacker_state_id === stateId;
    const currentAttacker = Math.max(0, Number(battle.attacker_score || 0));
    const currentDefender = Math.max(0, Number(battle.defender_score || 0));
    // A surrender must never fall into the <5% draw window, even late in a
    // high-scoring fight. Force the surviving side above the draw threshold.
    const attackerScore = attackerSurrenders ? currentAttacker : Math.max(currentAttacker, Math.ceil(currentDefender * 1.12) + 1);
    const defenderScore = attackerSurrenders ? Math.max(currentDefender, Math.ceil(currentAttacker * 1.12) + 1) : currentDefender;
    return resolveBattleByScore(battleId, attackerScore, defenderScore);
  });
}

