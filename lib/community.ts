import { getSupabaseAdmin } from "@/lib/supabase/server";
import { performDiplomacyAction } from "@/lib/diplomacy";
import { startWarAction } from "@/lib/actions";
import type { WarType } from "@/lib/types";

export type DutyRole = "diplomat" | "spy" | "miner" | "worker";
export type StateVoteKind = "war" | "alliance";

export const DUTY_ROLE_LABELS: Record<DutyRole, string> = {
  diplomat: "Дипломат",
  spy: "Шпион",
  miner: "Шахтёр",
  worker: "Рабочий",
};

const DUTY_ALIASES: Record<string, DutyRole> = {
  diplomat: "diplomat", "дипломат": "diplomat",
  spy: "spy", "шпион": "spy",
  miner: "miner", "шахтер": "miner", "шахтёр": "miner",
  worker: "worker", "рабочий": "worker",
};

export function parseDutyRole(raw: unknown): DutyRole | null {
  return DUTY_ALIASES[String(raw || "").trim().toLocaleLowerCase("ru-RU")] || null;
}

export async function setDutyRole(params: {
  stateId: string;
  actorPlayerId: string;
  targetPlayerId: string;
  dutyRole: DutyRole | null;
}) {
  const supabase = getSupabaseAdmin();
  const [{ data: actor, error: actorError }, { data: target, error: targetError }] = await Promise.all([
    supabase.from("state_members").select("role").eq("state_id", params.stateId).eq("player_id", params.actorPlayerId).maybeSingle(),
    supabase.from("state_members").select("role,duty_role").eq("state_id", params.stateId).eq("player_id", params.targetPlayerId).maybeSingle(),
  ]);
  if (actorError) throw actorError;
  if (targetError) throw targetError;
  if (!actor || !["founder", "president"].includes(String(actor.role))) throw new Error("Специализации назначает Президент или Основатель.");
  if (!target) throw new Error("Игрок не является гражданином этого государства.");

  const { error } = await supabase
    .from("state_members")
    .update({ duty_role: params.dutyRole })
    .eq("state_id", params.stateId)
    .eq("player_id", params.targetPlayerId);
  if (error) throw error;
  return params.dutyRole;
}

export async function listDutyRoles(stateId: string): Promise<Array<{ playerId: string; dutyRole: DutyRole; displayName: string; username: string | null }>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_members")
    .select("player_id,duty_role,player:players!state_members_player_id_fkey(display_name,username)")
    .eq("state_id", stateId)
    .not("duty_role", "is", null)
    .order("duty_role");
  if (error) throw error;
  return (data || []).map((row: any) => ({
    playerId: String(row.player_id),
    dutyRole: row.duty_role as DutyRole,
    displayName: String(row.player?.display_name || "Игрок"),
    username: row.player?.username ? String(row.player.username) : null,
  }));
}

export function isMissingDutyRoleError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const code = String(row.code || "");
  const text = [row.message, row.details, row.hint].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
  return text.includes("duty_role") && ["42703", "PGRST204", "PGRST205"].includes(code);
}

export async function applyWorkforceBonus<T extends Record<string, number>>(stateId: string, rates: T): Promise<T> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("state_members").select("duty_role").eq("state_id", stateId).in("duty_role", ["miner", "worker"]);
  // Rolling-deploy compatibility: duty roles were introduced after the core game.
  // A stale PostgREST schema cache or a not-yet-applied migration must not make
  // the whole Mini App unavailable. Production continues at base rates until the
  // column is visible, then bonuses start applying automatically.
  if (error && isMissingDutyRoleError(error)) return rates;
  if (error) throw error;
  const miners = (data || []).filter((row: any) => row.duty_role === "miner").length;
  const workers = (data || []).filter((row: any) => row.duty_role === "worker").length;
  const workerMultiplier = 1 + Math.min(0.20, workers * 0.04);
  const minerMultiplier = 1 + Math.min(0.40, miners * 0.08);
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    const workforce = key === "steel" ? workerMultiplier * minerMultiplier : workerMultiplier;
    next[key] = Math.max(0, Math.round(value * workforce));
  }
  return next as T;
}

export interface StateVoteRecord {
  id: string;
  state_id: string;
  vote_kind: StateVoteKind;
  target_state_id: string;
  payload: Record<string, unknown>;
  status: "open" | "approved" | "rejected" | "cancelled";
  ends_at: string;
  executed_at?: string | null;
  created_by_player_id: string;
}

export async function createStateVote(params: {
  stateId: string;
  createdByPlayerId: string;
  kind: StateVoteKind;
  targetStateId: string;
  payload?: Record<string, unknown>;
  durationMinutes?: number;
}) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("state_votes")
    .select("id,vote_kind,target_state_id,ends_at,status,executed_at")
    .eq("state_id", params.stateId)
    .in("status", ["open", "approved"])
    .is("executed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if ((existing as any).status === "approved") throw new Error("Предыдущее голосование одобрено, но ещё не исполнено. Нажмите кнопку голосования снова или используйте !голосование.");
    throw new Error(new Date(existing.ends_at).getTime() <= Date.now()
      ? "Предыдущее голосование уже истекло. Сначала подведите итог командой !голосование."
      : "В государстве уже идёт голосование. Сначала завершите его.");
  }

  const duration = Math.max(2, Math.min(30, Math.round(params.durationMinutes || 2)));
  const { data, error } = await supabase.from("state_votes").insert({
    state_id: params.stateId,
    created_by_player_id: params.createdByPlayerId,
    vote_kind: params.kind,
    target_state_id: params.targetStateId,
    payload: params.payload || {},
    status: "open",
    starts_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + duration * 60_000).toISOString(),
  }).select("*").single();
  if (error) throw error;
  return data as StateVoteRecord;
}

export async function getOpenStateVote(stateId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_votes")
    .select("*")
    .eq("state_id", stateId)
    .in("status", ["open", "approved"])
    .is("executed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as StateVoteRecord | null;
}

export async function getVoteSummary(voteId: string) {
  const supabase = getSupabaseAdmin();
  const { data: vote, error: voteError } = await supabase.from("state_votes").select("*").eq("id", voteId).single();
  if (voteError || !vote) throw new Error("Голосование не найдено.");
  const [{ count: eligible, error: eligibleError }, { data: ballots, error: ballotError }] = await Promise.all([
    supabase.from("state_members").select("id", { count: "exact", head: true }).eq("state_id", vote.state_id),
    supabase.from("state_vote_ballots").select("choice").eq("vote_id", voteId),
  ]);
  if (eligibleError) throw eligibleError;
  if (ballotError) throw ballotError;
  const yes = (ballots || []).filter((row: any) => row.choice === true).length;
  const no = (ballots || []).filter((row: any) => row.choice === false).length;
  const eligibleCount = Math.max(1, eligible || 1);
  const quorum = Math.min(3, Math.max(1, Math.ceil(eligibleCount * 0.20)));
  return { vote: vote as StateVoteRecord, yes, no, total: yes + no, eligible: eligibleCount, quorum };
}

export async function maybeFinalizeStateVote(voteId: string) {
  const summary = await getVoteSummary(voteId);
  if (summary.vote.status !== "open") return { ...summary, finalized: false };
  const absoluteMajority = Math.floor(summary.eligible / 2) + 1;
  const expired = new Date(summary.vote.ends_at).getTime() <= Date.now();
  let status: "approved" | "rejected" | null = null;
  if (summary.yes >= absoluteMajority) status = "approved";
  else if (summary.no >= absoluteMajority) status = "rejected";
  else if (expired) status = summary.total >= summary.quorum && summary.yes > summary.no ? "approved" : "rejected";
  if (!status) return { ...summary, finalized: false };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_votes")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", voteId)
    .eq("status", "open")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { ...summary, vote: (data || summary.vote) as StateVoteRecord, finalized: Boolean(data), status };
}

export async function castStateVote(voteId: string, playerId: string, choice: boolean) {
  const supabase = getSupabaseAdmin();
  const { data: vote, error: voteError } = await supabase.from("state_votes").select("state_id,status,ends_at,executed_at").eq("id", voteId).maybeSingle();
  if (voteError) throw voteError;
  if (!vote) throw new Error("Голосование не найдено.");
  if (vote.status === "approved" && !vote.executed_at) {
    return { ...(await getVoteSummary(voteId)), finalized: true, status: "approved" as const };
  }
  if (vote.status !== "open") throw new Error("Голосование уже завершено.");
  if (new Date(vote.ends_at).getTime() <= Date.now()) return maybeFinalizeStateVote(voteId);
  const { data: member, error: memberError } = await supabase.from("state_members").select("id").eq("state_id", vote.state_id).eq("player_id", playerId).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new Error("Голосовать могут только граждане этого государства.");
  const { error } = await supabase.from("state_vote_ballots").upsert({ vote_id: voteId, player_id: playerId, choice, updated_at: new Date().toISOString() }, { onConflict: "vote_id,player_id" });
  if (error) throw error;
  return maybeFinalizeStateVote(voteId);
}

export async function getDueVotesForChat(chatId: number) {
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase.from("states").select("id").eq("telegram_chat_id", chatId).maybeSingle();
  if (stateError) throw stateError;
  if (!state) return [] as StateVoteRecord[];
  const { data, error } = await supabase
    .from("state_votes")
    .select("*")
    .eq("state_id", state.id)
    .in("status", ["open", "approved"])
    .is("executed_at", null)
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw error;
  const now = Date.now();
  return (data || []).filter((vote: any) => vote.status === "approved" || new Date(vote.ends_at).getTime() <= now) as StateVoteRecord[];
}

export async function executeApprovedStateVote(voteId: string) {
  const supabase = getSupabaseAdmin();
  const { data: claimed, error: claimError } = await supabase
    .from("state_votes")
    .update({ executed_at: new Date().toISOString() })
    .eq("id", voteId)
    .eq("status", "approved")
    .is("executed_at", null)
    .select("*")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { executed: false as const };
  const vote = claimed as StateVoteRecord;
  try {
    if (vote.vote_kind === "war") {
      const battleType = String(vote.payload?.battleType || "raid") as WarType;
      const battleId = await startWarAction({ actorRole: "president", attackerStateId: vote.state_id, defenderStateId: vote.target_state_id, battleType });
      return { executed: true as const, kind: "war" as const, battleId, battleType, vote };
    }
    const action = String(vote.payload?.action || "propose");
    await performDiplomacyAction(vote.state_id, vote.target_state_id, action === "accept" ? "accept_alliance" : "propose_alliance");
    return { executed: true as const, kind: "alliance" as const, action, vote };
  } catch (error) {
    try {
      await supabase.from("state_votes").update({ executed_at: null }).eq("id", voteId);
    } catch {
      // Best effort: the vote remains approved and can be retried manually.
    }
    throw error;
  }
}

export async function startSpyQuest(params: {
  playerId: string;
  stateId: string;
  targetStateId: string;
  kind: "recon" | "treasury";
}) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error: expireError } = await supabase
    .from("spy_quests")
    .update({ status: "expired", resolved_at: now })
    .eq("player_id", params.playerId)
    .eq("status", "active")
    .lte("expires_at", now);
  if (expireError) throw expireError;

  const [{ data: member, error: memberError }, { data: states, error: statesError }, { data: recent, error: recentError }] = await Promise.all([
    supabase.from("state_members").select("duty_role").eq("state_id", params.stateId).eq("player_id", params.playerId).maybeSingle(),
    supabase.from("states").select("id,is_freeport,is_beginner_island").in("id", [params.stateId, params.targetStateId]),
    supabase.from("spy_quests").select("created_at").eq("player_id", params.playerId).gte("created_at", new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (memberError) throw memberError;
  if (statesError) throw statesError;
  if (recentError) throw recentError;
  const ownState = (states || []).find((row: any) => String(row.id) === params.stateId);
  const target = (states || []).find((row: any) => String(row.id) === params.targetStateId);
  if (member?.duty_role !== "spy") throw new Error("Шпионский квест доступен только участнику со специализацией «Шпион».");
  if (!ownState || ownState.is_freeport || ownState.is_beginner_island) throw new Error("Из защищённой территории шпионские операции недоступны.");
  if (!target || target.is_freeport) throw new Error("Эта цель недоступна для шпионской операции.");
  if (target.is_beginner_island) throw new Error("Остров новичков защищён от шпионских операций.");
  if (params.stateId === params.targetStateId) throw new Error("Шпионить за собственной канцелярией слишком мета.");
  if (recent) throw new Error("Шпион уже был на задании. Новая операция доступна раз в 6 часов.");
  const { data, error } = await supabase.from("spy_quests").insert({
    player_id: params.playerId,
    state_id: params.stateId,
    target_state_id: params.targetStateId,
    quest_kind: params.kind,
    status: "active",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }).select("id,quest_kind,target_state_id").single();
  if (error) throw error;
  return data;
}

export async function resolveSpyQuest(questId: string, playerId: string, option: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_resolve_spy_quest", {
    p_quest_id: questId,
    p_player_id: playerId,
    p_option: option,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}
