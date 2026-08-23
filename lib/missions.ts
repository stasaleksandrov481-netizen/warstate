import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DailyMissionView, MissionKey } from "@/lib/types";

export const DAILY: Array<{ key: MissionKey; title: string; description: string; target: number; rewardXp: number; rewardCredits: number }> = [
  { key: "check_in", title: "На связи", description: "Открой GROUP WARS сегодня", target: 1, rewardXp: 80, rewardCredits: 300 },
  { key: "join_battle", title: "Мобилизация", description: "Войди хотя бы в одну битву", target: 1, rewardXp: 140, rewardCredits: 450 },
  { key: "battle_action", title: "На передовой", description: "Совершите 5 действий в бою", target: 5, rewardXp: 180, rewardCredits: 600 },
  { key: "capture_point", title: "Захватчик", description: "Захвати одну точку A/B/C", target: 1, rewardXp: 220, rewardCredits: 800 },
];

export async function ensureDailyMissions(playerId: string, stateId: string) {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const rows = DAILY.map((mission) => ({
    player_id: playerId,
    state_id: stateId,
    mission_date: today,
    mission_key: mission.key,
    title: mission.title,
    description: mission.description,
    target: mission.target,
    reward_xp: mission.rewardXp,
    reward_credits: mission.rewardCredits,
  }));
  const { error } = await supabase.from("player_daily_missions").upsert(rows, {
    onConflict: "player_id,state_id,mission_date,mission_key",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

export async function recordMissionProgress(playerId: string, stateId: string, key: MissionKey, amount = 1) {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const mission = DAILY.find((item) => item.key === key);
  if (!mission) return;
  const { error: ensureError } = await supabase.from("player_daily_missions").upsert({
    player_id: playerId,
    state_id: stateId,
    mission_date: today,
    mission_key: mission.key,
    title: mission.title,
    description: mission.description,
    target: mission.target,
    reward_xp: mission.rewardXp,
    reward_credits: mission.rewardCredits,
  }, { onConflict: "player_id,state_id,mission_date,mission_key", ignoreDuplicates: true });
  if (ensureError) throw ensureError;
  const { error } = await supabase.rpc("gw_progress_daily_mission", {
    p_player_id: playerId,
    p_state_id: stateId,
    p_mission_key: key,
    p_amount: Math.max(1, Math.floor(amount)),
  });
  if (error) throw error;
}

export async function getDailyMissions(playerId: string, stateId: string): Promise<DailyMissionView[]> {
  await ensureDailyMissions(playerId, stateId);
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("player_daily_missions")
    .select("id,mission_key,title,description,progress,target,reward_xp,reward_credits,claimed_at")
    .eq("player_id", playerId)
    .eq("state_id", stateId)
    .eq("mission_date", today)
    .order("created_at");
  if (error) throw error;
  return (data || []).map((row: any) => ({
    id: row.id,
    key: row.mission_key,
    title: row.title,
    description: row.description,
    progress: row.progress,
    target: row.target,
    rewardXp: row.reward_xp,
    rewardCredits: row.reward_credits,
    claimed: Boolean(row.claimed_at),
  }));
}

export async function claimDailyMission(playerId: string, stateId: string, missionId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_claim_daily_mission", {
    p_player_id: playerId,
    p_state_id: stateId,
    p_mission_id: missionId,
  });
  if (error) throw error;
  return data;
}
