import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recordWorldEvent } from "@/lib/diplomacy";
import { recordMissionProgress } from "@/lib/missions";
import type { BattleClass, BattleEventView, BattleOrderKind, BattleOrderView, BattlePlayerView, BattlePoint, BattleTeam, BattleView } from "@/lib/types";
import { requireData } from "@/lib/invariants";

const POINTS: BattlePoint[] = ["A", "B", "C"];
const BATTLE_SECONDS = 180;
const SCORE_TO_WIN = 300;

function nowIso() {
  return new Date().toISOString();
}

function eventText(row: any): string {
  const p = row.payload || {};
  switch (row.event_type) {
    case "join": return `${p.name || "Игрок"} вошёл в бой`;
    case "move": return `${p.name || "Игрок"} → точка ${p.point}`;
    case "capture": return `${p.name || "Отряд"} захватил точку ${p.point}`;
    case "hit": return `${p.name || "Игрок"} попал по ${p.target || "противнику"} (${p.damage || 0})`;
    case "kill": return `${p.name || "Игрок"} выбил ${p.target || "противника"}`;
    case "heal": return `${p.name || "Медик"} восстановил ${p.target || "союзника"} (+${p.amount || 0})`;
    case "respawn": return `${p.name || "Игрок"} вернулся в бой`;
    case "order": return `${p.name || "Командир"}: ${p.kind === "attack" ? "штурм" : p.kind === "defend" ? "оборона" : "сбор"} на ${p.point}`;
    case "finish": return p.text || "Битва завершена";
    default: return row.event_type;
  }
}

async function addEvent(battleId: string, playerId: string | null, eventType: string, payload: Record<string, unknown> = {}) {
  const supabase = getSupabaseAdmin();
  await supabase.from("battle_events").insert({ battle_id: battleId, player_id: playerId, event_type: eventType, payload });
}

async function resolveBattleRow(battle: any, attackerScore: number, defenderScore: number) {
  if (battle.status === "resolved") return battle;
  const supabase = getSupabaseAdmin();
  const attackerWon = attackerScore > defenderScore;

  const { data: result, error } = await supabase.rpc("gw_finalize_battle", {
    p_battle_id: battle.id,
    p_attacker_score: attackerScore,
    p_defender_score: defenderScore,
  });
  if (error) throw error;

  const resolved = result?.battle || battle;

  // Rewarding is idempotent per battle/player. Run this even when the battle was
  // already resolved so a serverless retry can heal a partial previous request.
  const { data: participants, error: participantsError } = await supabase
    .from("battle_players")
    .select("player_id,state_id,contribution")
    .eq("battle_id", battle.id);
  if (participantsError) throw participantsError;
  const rewardResults = await Promise.all((participants || []).map((participant: any) => {
    const rewardXp = 35 + Math.min(140, participant.contribution || 0);
    return supabase.rpc("gw_award_battle_player_once", {
      p_battle_id: battle.id,
      p_player_id: participant.player_id,
      p_state_id: participant.state_id,
      p_reward_xp: rewardXp,
    });
  }));
  const rewardError = rewardResults.find((item) => item.error)?.error;
  if (rewardError) throw rewardError;

  if (!result?.applied) return resolved;

  const islandBattle = (resolved as any).battle_kind === "island" || battle.battle_kind === "island";
  await addEvent(battle.id, null, "finish", {
    text: attackerWon
      ? (islandBattle ? `Остров атакующих победил ${attackerScore}:${defenderScore}` : `Атакующие победили ${attackerScore}:${defenderScore}`)
      : (islandBattle ? `Защитники острова отбили атаку ${defenderScore}:${attackerScore}` : `Защита удержала сектор ${defenderScore}:${attackerScore}`),
  });
  const { data: namedStates } = await supabase.from("states").select("id,name").in("id", [battle.attacker_state_id, battle.defender_state_id].filter(Boolean));
  const attackerName = namedStates?.find((state: any) => state.id === battle.attacker_state_id)?.name || "Атакующие";
  const defenderName = namedStates?.find((state: any) => state.id === battle.defender_state_id)?.name || "Гарнизон";
  const destroyed = Boolean(result?.islandDestroyed);
  const integrityDamage = Number(result?.integrityDamage || 0);
  const defenderIntegrity = Number(result?.defenderIntegrity ?? 100);
  await recordWorldEvent({
    eventType: islandBattle
      ? (attackerWon ? (destroyed ? "island_destroyed" : "island_damaged") : "island_defended")
      : "battle_resolved",
    title: islandBattle
      ? (attackerWon ? (destroyed ? "Остров разрушен" : "Остров повреждён") : "Остров выстоял")
      : (attackerWon ? "Территория захвачена" : "Наступление отбито"),
    body: islandBattle
      ? (attackerWon
          ? (destroyed
              ? `${attackerName} добил оборону ${defenderName} ${attackerScore}:${defenderScore}. Остров превращён в руины.`
              : `${attackerName} выиграл вторжение ${attackerScore}:${defenderScore} и снял ${integrityDamage}% прочности. У ${defenderName} осталось ${defenderIntegrity}%.`)
          : `${defenderName} отбил морскую атаку ${attackerName}. Счёт ${defenderScore}:${attackerScore}.`)
      : (attackerWon
          ? `${attackerName} победил ${defenderName} со счётом ${attackerScore}:${defenderScore} и занял сектор.`
          : `${defenderName} удержал сектор против ${attackerName}. Счёт ${defenderScore}:${attackerScore}.`),
    actorStateId: attackerWon ? battle.attacker_state_id : battle.defender_state_id,
    targetStateId: attackerWon ? battle.defender_state_id : battle.attacker_state_id,
    payload: {
      battleId: battle.id,
      tileId: battle.tile_id,
      battleKind: islandBattle ? "island" : "territory",
      attackerScore,
      defenderScore,
      integrityDamage,
      defenderIntegrity,
      destroyed,
      attackerRatingDelta: result?.attackerRatingDelta || 0,
      defenderRatingDelta: result?.defenderRatingDelta || 0,
      lootCredits: result?.lootCredits || 0,
    },
  }).catch(() => null);
  return resolved;
}

export async function tickBattle(battleId: string) {
  const supabase = getSupabaseAdmin();
  const { data: battle, error } = await supabase.from("battles").select("*").eq("id", battleId).single();
  if (error) throw error;
  const battleRow = requireData(battle, "Битва не найдена.");
  if (battleRow.status === "resolved" || battleRow.status === "cancelled") return battleRow;

  const now = Date.now();
  const last = new Date(battleRow.last_tick_at).getTime();
  const end = new Date(battleRow.ends_at).getTime();
  const cappedNow = Math.min(now, end);
  const elapsedSeconds = Math.max(0, Math.floor((cappedNow - last) / 1000));
  let attackerScore = battleRow.attacker_score || 0;
  let defenderScore = battleRow.defender_score || 0;

  if (elapsedSeconds > 0) {
    const owners = [battleRow.point_a_owner, battleRow.point_b_owner, battleRow.point_c_owner];
    attackerScore += owners.filter((owner) => owner === "attacker").length * elapsedSeconds;
    defenderScore += owners.filter((owner) => owner === "defender").length * elapsedSeconds;
    const { data: ticked } = await supabase.from("battles").update({
      attacker_score: attackerScore,
      defender_score: defenderScore,
      last_tick_at: new Date(cappedNow).toISOString(),
    }).eq("id", battleId).eq("last_tick_at", battleRow.last_tick_at).select("*").maybeSingle();
    if (!ticked) {
      const { data: concurrent } = await supabase.from("battles").select("attacker_score,defender_score,last_tick_at").eq("id", battleId).single();
      attackerScore = concurrent?.attacker_score ?? attackerScore;
      defenderScore = concurrent?.defender_score ?? defenderScore;
    }
  }

  const { data: dead } = await supabase
    .from("battle_players")
    .select("id,player_id,team,players!battle_players_player_id_fkey(display_name)")
    .eq("battle_id", battleId)
    .eq("hp", 0)
    .lte("respawn_at", nowIso());
  for (const row of dead || []) {
    await supabase.from("battle_players").update({ hp: 100, respawn_at: null, point: row.team === "defender" ? "C" : "A", updated_at: nowIso() }).eq("id", row.id);
    const player: any = row.players;
    await addEvent(battleId, row.player_id, "respawn", { name: player?.display_name || "Игрок" });
  }

  if (now >= end || attackerScore >= SCORE_TO_WIN || defenderScore >= SCORE_TO_WIN) {
    return resolveBattleRow(battleRow, attackerScore, defenderScore);
  }

  const { data: refreshed } = await supabase.from("battles").select("*").eq("id", battleId).single();
  return refreshed || battleRow;
}

export async function createBattle(attackerStateId: string, tileId: string) {
  const supabase = getSupabaseAdmin();
  const [{ data: target, error: targetError }, { data: ownTiles, error: ownError }] = await Promise.all([
    supabase.from("tiles").select("*").eq("id", tileId).single(),
    supabase.from("tiles").select("id,q,r").eq("owner_state_id", attackerStateId),
  ]);
  if (targetError) throw targetError;
  if (ownError) throw ownError;
  const targetTile = requireData(target, "Сектор не найден.");
  if (targetTile.owner_state_id === attackerStateId) throw new Error("Эта территория уже ваша.");

  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  const adjacent = (ownTiles || []).some((own: any) => dirs.some(([dq, dr]) => own.q + dq === targetTile.q && own.r + dr === targetTile.r));
  if (!adjacent) throw new Error("Атаковать можно только соседний сектор.");

  const { data: battleId, error: startError } = await supabase.rpc("gw_start_battle", {
    p_attacker_state_id: attackerStateId,
    p_expected_defender_state_id: targetTile.owner_state_id || null,
    p_tile_id: tileId,
    p_duration_seconds: BATTLE_SECONDS,
  });
  if (startError) throw startError;
  if (!battleId) throw new Error("Не удалось создать битву.");

  const { data: namedStates } = await supabase.from("states").select("id,name").in("id", [attackerStateId, targetTile.owner_state_id].filter(Boolean));
  const attackerName = namedStates?.find((row: any) => row.id === attackerStateId)?.name || "Государство";
  const defenderName = namedStates?.find((row: any) => row.id === targetTile.owner_state_id)?.name || "Нейтральный сектор";
  await recordWorldEvent({
    eventType: "battle_started",
    title: "Началась битва",
    body: `${attackerName} атакует ${defenderName}. Операция продлится 3 минуты.`,
    actorStateId: attackerStateId,
    targetStateId: targetTile.owner_state_id || null,
    payload: { battleId, tileId },
  }).catch(() => null);
  return getBattleView(String(battleId), null);
}

export async function joinBattle(battleId: string, playerId: string, stateId: string, klass: BattleClass = "assault") {
  const supabase = getSupabaseAdmin();
  const battle = await tickBattle(battleId);
  if (battle.status !== "active") throw new Error("Битва уже завершена.");
  const team: BattleTeam | null = stateId === battle.attacker_state_id ? "attacker" : stateId === battle.defender_state_id ? "defender" : null;
  if (!team) throw new Error("Ваше государство не участвует в этой битве.");

  const [{ data: player }, { count: teamCount }, { data: existingPlayer, error: existingError }] = await Promise.all([
    supabase.from("players").select("display_name").eq("id", playerId).single(),
    supabase.from("battle_players").select("id", { count: "exact", head: true }).eq("battle_id", battleId).eq("team", team),
    supabase.from("battle_players").select("id,squad_code,team").eq("battle_id", battleId).eq("player_id", playerId).maybeSingle(),
  ]);
  if (existingError) throw existingError;
  const squads = ["ALPHA", "BRAVO", "CHARLIE"] as const;
  const squadCode = existingPlayer?.squad_code || squads[(teamCount || 0) % squads.length];

  if (existingPlayer) {
    if (existingPlayer.team !== team) throw new Error("Игрок уже зарегистрирован за другую сторону.");
    const { error: updateError } = await supabase.from("battle_players").update({ class: klass, updated_at: nowIso() }).eq("id", existingPlayer.id);
    if (updateError) throw updateError;
  } else {
    const { error: insertError } = await supabase.from("battle_players").insert({
      battle_id: battleId,
      player_id: playerId,
      state_id: stateId,
      team,
      class: klass,
      squad_code: squadCode,
      hp: 100,
      point: team === "attacker" ? "A" : "C",
      respawn_at: null,
      updated_at: nowIso(),
    });
    if (insertError) throw insertError;
    await addEvent(battleId, playerId, "join", { name: player?.display_name || "Игрок", team, class: klass });
  }
  await recordMissionProgress(playerId, stateId, "join_battle").catch(() => null);
  return getBattleView(battleId, playerId);
}

export async function battleAction(battleId: string, playerId: string, action: string, payload: any = {}) {
  const supabase = getSupabaseAdmin();

  if (action === "order") {
    const role = String(payload.role || "citizen");
    const stateId = String(payload.stateId || "");
    const point = payload.point as BattlePoint;
    const kind = payload.kind as BattleOrderKind;
    if (!["president", "minister", "general"].includes(role)) throw new Error("Отдавать приказы может президент, министр или генерал.");
    if (!POINTS.includes(point)) throw new Error("Неизвестная точка приказа.");
    if (!["attack", "defend", "rally"].includes(kind)) throw new Error("Неизвестный тип приказа.");
    const battle = await tickBattle(battleId);
    const team: BattleTeam | null = stateId === battle.attacker_state_id ? "attacker" : stateId === battle.defender_state_id ? "defender" : null;
    if (!team) throw new Error("Ваше государство не участвует в этой битве.");
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const { error } = await supabase.from("battle_orders").upsert({
      battle_id: battleId,
      state_id: stateId,
      issued_by_player_id: playerId,
      team,
      point,
      kind,
      created_at: nowIso(),
      expires_at: expiresAt,
    }, { onConflict: "battle_id,state_id" });
    if (error) throw error;
    const { data: issuer } = await supabase.from("players").select("display_name").eq("id", playerId).single();
    await addEvent(battleId, playerId, "order", { name: issuer?.display_name || "Командир", point, kind, team });
    return getBattleView(battleId, playerId);
  }

  await tickBattle(battleId);
  const { error } = await supabase.rpc("gw_battle_action", {
    p_battle_id: battleId,
    p_player_id: playerId,
    p_action: action,
    p_payload: payload || {},
  });
  if (error) throw new Error(error.message || "Действие не удалось.");
  return getBattleView(battleId, playerId);
}

export async function getBattleView(battleId: string, playerId: string | null): Promise<BattleView> {
  const supabase = getSupabaseAdmin();
  await tickBattle(battleId);
  const [battleRes, playersRes, eventsRes, ordersRes] = await Promise.all([
    supabase.from("battles").select(`*,attacker:states!battles_attacker_state_id_fkey(name,color),defender:states!battles_defender_state_id_fkey(name,color)`).eq("id", battleId).single(),
    supabase.from("battle_players").select(`*,player:players!battle_players_player_id_fkey(display_name)`).eq("battle_id", battleId).order("joined_at"),
    supabase.from("battle_events").select("id,event_type,payload,created_at").eq("battle_id", battleId).order("id", { ascending: false }).limit(12),
    supabase.from("battle_orders").select(`*,issuer:players!battle_orders_issued_by_player_id_fkey(display_name)`).eq("battle_id", battleId).gt("expires_at", nowIso()),
  ]);
  if (battleRes.error) throw battleRes.error;
  if (playersRes.error) throw playersRes.error;
  if (eventsRes.error) throw eventsRes.error;
  if (ordersRes.error) throw ordersRes.error;
  const battle: any = requireData(battleRes.data, "Битва не найдена.");
  const players: BattlePlayerView[] = (playersRes.data || []).map((row: any) => ({
    id: row.id,
    playerId: row.player_id,
    displayName: row.player?.display_name || "Игрок",
    team: row.team,
    class: row.class,
    hp: row.hp,
    point: row.point,
    kills: row.kills,
    deaths: row.deaths,
    contribution: row.contribution,
    squadCode: row.squad_code,
    cooldownUntil: row.cooldown_until,
    respawnAt: row.respawn_at,
  }));
  const me = playerId ? players.find((p) => p.playerId === playerId) || null : null;
  let myRole: string | null = null;
  if (playerId) {
    const stateIds = [battle.attacker_state_id, battle.defender_state_id].filter(Boolean);
    const { data: membership } = await supabase.from("state_members").select("role").eq("player_id", playerId).in("state_id", stateIds).limit(1).maybeSingle();
    myRole = membership?.role || null;
  }
  const orders: BattleOrderView[] = (ordersRes.data || []).map((row: any) => ({
    id: row.id,
    team: row.team,
    stateId: row.state_id,
    point: row.point,
    kind: row.kind,
    issuedBy: row.issuer?.display_name || null,
    expiresAt: row.expires_at,
  }));
  const events: BattleEventView[] = (eventsRes.data || []).map((row: any) => ({
    id: Number(row.id),
    type: row.event_type,
    text: eventText(row),
    createdAt: row.created_at,
  }));
  return {
    id: battle.id,
    tileId: battle.tile_id || null,
    battleKind: battle.battle_kind === "island" ? "island" : "territory",
    attackerStateId: battle.attacker_state_id,
    defenderStateId: battle.defender_state_id,
    attackerName: battle.attacker?.name || "Атакующие",
    defenderName: battle.defender?.name || "Нейтральный гарнизон",
    attackerColor: battle.attacker?.color || "#9b7cff",
    defenderColor: battle.defender?.color || "#ff5267",
    status: battle.status,
    startsAt: battle.starts_at,
    endsAt: battle.ends_at,
    attackerScore: battle.attacker_score,
    defenderScore: battle.defender_score,
    pointOwners: {
      A: battle.point_a_owner,
      B: battle.point_b_owner,
      C: battle.point_c_owner,
    },
    winnerStateId: battle.winner_state_id,
    myTeam: me?.team || null,
    myRole,
    me,
    players,
    orders,
    events,
  };
}

export async function findActiveBattleForState(stateId: string, playerId: string | null) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("battles")
    .select("id")
    .in("status", ["scheduled", "active"])
    .or(`attacker_state_id.eq.${stateId},defender_state_id.eq.${stateId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ? getBattleView(data.id, playerId) : null;
}
