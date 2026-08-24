import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DiplomacyAction, DiplomacyRelationView, DiplomacyStatus, LeaderboardStateView, WorldEventView } from "@/lib/types";
import { requireData } from "@/lib/invariants";

function canonicalPair(a: string, b: string) {
  return a.localeCompare(b) < 0 ? [a, b] as const : [b, a] as const;
}

export async function recordWorldEvent(input: {
  eventType: string;
  title: string;
  body: string;
  actorStateId?: string | null;
  targetStateId?: string | null;
  payload?: Record<string, unknown>;
}) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("world_events").insert({
    event_type: input.eventType,
    actor_state_id: input.actorStateId || null,
    target_state_id: input.targetStateId || null,
    title: input.title,
    body: input.body,
    payload: input.payload || {},
  });
  if (error) throw error;
}

export async function getDiplomacyForState(stateId: string): Promise<DiplomacyRelationView[]> {
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from("diplomacy_relations")
    .select("*")
    .or(`state_a_id.eq.${stateId},state_b_id.eq.${stateId}`)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const otherIds = [...new Set((rows || []).map((r: any) => r.state_a_id === stateId ? r.state_b_id : r.state_a_id))];
  if (!otherIds.length) return [];
  const { data: states, error: statesError } = await supabase.from("states").select("id,name,state_username,color").in("id", otherIds);
  if (statesError) throw statesError;
  const byId = new Map((states || []).map((s: any) => [s.id, s]));
  return (rows || []).map((row: any) => {
    const otherId = row.state_a_id === stateId ? row.state_b_id : row.state_a_id;
    const other: any = byId.get(otherId);
    return {
      id: row.id,
      otherStateId: otherId,
      otherStateName: other?.name || "Unknown state",
      otherStateUsername: other?.state_username || null,
      otherStateColor: other?.color || "#6f7684",
      status: row.status as DiplomacyStatus,
      requestedByStateId: row.requested_by_state_id,
      truceUntil: row.truce_until,
      updatedAt: row.updated_at,
    };
  });
}


export async function getAlliedStateChats(stateId: string) {
  const supabase = getSupabaseAdmin();
  const { data: relations, error } = await supabase
    .from("diplomacy_relations")
    .select("state_a_id,state_b_id")
    .eq("status", "allied")
    .or(`state_a_id.eq.${stateId},state_b_id.eq.${stateId}`);
  if (error) throw error;
  const allyIds = [...new Set((relations || []).map((row: any) => String(row.state_a_id) === stateId ? String(row.state_b_id) : String(row.state_a_id)))];
  if (!allyIds.length) return [] as Array<{ id: string; name: string; telegramChatId: number }>;
  const { data: states, error: statesError } = await supabase
    .from("states")
    .select("id,name,telegram_chat_id,is_freeport")
    .in("id", allyIds);
  if (statesError) throw statesError;
  return (states || [])
    .filter((state: any) => !state.is_freeport && state.telegram_chat_id)
    .map((state: any) => ({ id: String(state.id), name: String(state.name), telegramChatId: Number(state.telegram_chat_id) }));
}

export async function getWorldFeed(limit = 24): Promise<WorldEventView[]> {
  const supabase = getSupabaseAdmin();
  const { data: events, error } = await supabase
    .from("world_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const ids = [...new Set((events || []).flatMap((e: any) => [e.actor_state_id, e.target_state_id]).filter(Boolean))];
  let states: any[] = [];
  if (ids.length) {
    const { data, error: statesError } = await supabase.from("states").select("id,name,color").in("id", ids);
    if (statesError) throw statesError;
    states = data || [];
  }
  const byId = new Map(states.map((s: any) => [s.id, s]));
  return (events || []).map((event: any) => {
    const actor: any = event.actor_state_id ? byId.get(event.actor_state_id) : null;
    const target: any = event.target_state_id ? byId.get(event.target_state_id) : null;
    return {
      id: Number(event.id),
      kind: event.event_type,
      title: event.title,
      text: event.body,
      actorStateId: event.actor_state_id,
      actorStateName: actor?.name || null,
      actorStateColor: actor?.color || null,
      targetStateId: event.target_state_id,
      targetStateName: target?.name || null,
      targetStateColor: target?.color || null,
      createdAt: event.created_at,
    };
  });
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardStateView[]> {
  const supabase = getSupabaseAdmin();
  const { data: states, error } = await supabase
    .from("states")
    .select("id,name,state_username,color,rating,telegram_member_count,is_freeport")
    .eq("is_freeport", false)
    .order("rating", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (states || []).map((state: any, index: number) => ({
    id: state.id,
    name: state.name,
    stateUsername: state.state_username || null,
    color: state.color,
    rating: state.rating,
    rank: index + 1,
    memberCount: Math.max(1, Number(state.telegram_member_count || 1)),
  }));
}

async function getRelation(a: string, b: string) {
  const supabase = getSupabaseAdmin();
  const [stateA, stateB] = canonicalPair(a, b);
  const { data, error } = await supabase.from("diplomacy_relations").select("*").eq("state_a_id", stateA).eq("state_b_id", stateB).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertRelation(a: string, b: string, status: DiplomacyStatus, requestedByStateId: string | null, truceUntil: string | null = null) {
  const supabase = getSupabaseAdmin();
  const [stateA, stateB] = canonicalPair(a, b);
  const { data, error } = await supabase.from("diplomacy_relations").upsert({
    state_a_id: stateA,
    state_b_id: stateB,
    status,
    requested_by_state_id: requestedByStateId,
    truce_until: truceUntil,
    updated_at: new Date().toISOString(),
  }, { onConflict: "state_a_id,state_b_id" }).select("*").single();
  if (error) throw error;
  return requireData(data, "Не удалось обновить дипломатические отношения.");
}

export async function ensureWarRelation(attackerStateId: string, defenderStateId: string | null) {
  if (!defenderStateId) return;
  const relation = await getRelation(attackerStateId, defenderStateId);
  if (relation?.status === "allied") throw new Error("Нельзя атаковать союзника. Сначала разорвите союз.");
  if (relation?.status === "truce" && relation.truce_until && new Date(relation.truce_until).getTime() > Date.now()) {
    throw new Error("Действует перемирие. Атаковать пока нельзя.");
  }
  await upsertRelation(attackerStateId, defenderStateId, "war", attackerStateId, null);
}

export async function performDiplomacyAction(actorStateId: string, targetStateId: string, action: DiplomacyAction) {
  if (!targetStateId || actorStateId === targetStateId) throw new Error("Выберите другое государство.");
  const supabase = getSupabaseAdmin();
  const { data: states, error: statesError } = await supabase.from("states").select("id,name").in("id", [actorStateId, targetStateId]);
  if (statesError) throw statesError;
  const actor = states?.find((s: any) => s.id === actorStateId);
  const target = states?.find((s: any) => s.id === targetStateId);
  if (!actor || !target) throw new Error("Государство не найдено.");
  const relation = await getRelation(actorStateId, targetStateId);

  if (action === "propose_alliance") {
    if (relation?.status === "allied") throw new Error("Вы уже союзники.");
    if (relation?.status === "war") throw new Error("Сначала договоритесь о перемирии.");
    await upsertRelation(actorStateId, targetStateId, "alliance_pending", actorStateId);
    await recordWorldEvent({ eventType: "alliance_offer", title: "Предложен союз", body: `${actor.name} предложил союз государству ${target.name}.`, actorStateId, targetStateId });
  } else if (action === "accept_alliance") {
    if (relation?.status !== "alliance_pending" || relation.requested_by_state_id === actorStateId) throw new Error("Нет входящего предложения союза.");
    await upsertRelation(actorStateId, targetStateId, "allied", null);
    await recordWorldEvent({ eventType: "alliance", title: "Новый альянс", body: `${actor.name} и ${target.name} заключили союз.`, actorStateId, targetStateId });
  } else if (action === "reject_alliance") {
    if (relation?.status !== "alliance_pending" || relation.requested_by_state_id === actorStateId) throw new Error("Нет входящего предложения союза.");
    const [stateA, stateB] = canonicalPair(actorStateId, targetStateId);
    const { error } = await supabase.from("diplomacy_relations").delete().eq("state_a_id", stateA).eq("state_b_id", stateB);
    if (error) throw error;
    await recordWorldEvent({ eventType: "alliance_rejected", title: "Союз отклонён", body: `${actor.name} отклонил предложение союза от ${target.name}.`, actorStateId, targetStateId });
  } else if (action === "declare_war") {
    if (relation?.status === "truce" && relation.truce_until && new Date(relation.truce_until).getTime() > Date.now()) throw new Error("Перемирие ещё действует.");
    const betrayal = relation?.status === "allied";
    await upsertRelation(actorStateId, targetStateId, "war", actorStateId);
    await recordWorldEvent({ eventType: betrayal ? "betrayal" : "war_declared", title: betrayal ? "Союз разрушен" : "Объявлена война", body: betrayal ? `${actor.name} разорвал союз с ${target.name} и объявил войну.` : `${actor.name} объявил войну государству ${target.name}.`, actorStateId, targetStateId });
  } else if (action === "offer_truce") {
    if (relation?.status !== "war") throw new Error("Перемирие можно предложить только во время войны.");
    await upsertRelation(actorStateId, targetStateId, "truce_pending", actorStateId);
    await recordWorldEvent({ eventType: "truce_offer", title: "Предложено перемирие", body: `${actor.name} предложил ${target.name} прекратить огонь.`, actorStateId, targetStateId });
  } else if (action === "accept_truce") {
    if (relation?.status !== "truce_pending" || relation.requested_by_state_id === actorStateId) throw new Error("Нет входящего предложения перемирия.");
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await upsertRelation(actorStateId, targetStateId, "truce", null, until);
    await recordWorldEvent({ eventType: "truce", title: "Огонь прекращён", body: `${actor.name} и ${target.name} заключили перемирие на 24 часа.`, actorStateId, targetStateId });
  } else if (action === "break_alliance") {
    if (relation?.status !== "allied") throw new Error("Активного союза нет.");
    const [stateA, stateB] = canonicalPair(actorStateId, targetStateId);
    const { error } = await supabase.from("diplomacy_relations").delete().eq("state_a_id", stateA).eq("state_b_id", stateB);
    if (error) throw error;
    await recordWorldEvent({ eventType: "alliance_broken", title: "Альянс распался", body: `${actor.name} вышел из союза с ${target.name}.`, actorStateId, targetStateId });
  }

  return getDiplomacyForState(actorStateId);
}
