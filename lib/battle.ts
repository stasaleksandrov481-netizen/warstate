import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recordWorldEvent } from "@/lib/diplomacy";
import { recordMissionProgress } from "@/lib/missions";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
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
  const { error } = await supabase.from("battle_events").insert({ battle_id: battleId, player_id: playerId, event_type: eventType, payload });
  if (error) throw error;

  // Important battle moments are pushed to Telegram, but not every movement/hit.
  // This keeps chats alive without turning the bot into a notification machine.
  if (eventType === "capture") {
    try {
      const { data: battle } = await supabase
        .from("battles")
        .select("attacker_state_id,defender_state_id")
        .eq("id", battleId)
        .maybeSingle();
      const ids = [battle?.attacker_state_id, battle?.defender_state_id].filter(Boolean);
      if (ids.length) {
        const { data: states } = await supabase
          .from("states")
          .select("name,telegram_chat_id")
          .in("id", ids);
        const text = `⚔️ ИДЕТ БИТВА\n\n${String(payload.name || "Отряд")} захватил точку ${String(payload.point || "?")}. Бой продолжается.`;
        await Promise.allSettled((states || []).map((state: any) =>
          telegramApi("sendMessage", {
            chat_id: Number(state.telegram_chat_id),
            text,
            link_preview_options: { is_disabled: true },
          })
        ));
      }
    } catch {
      // Progress notifications are optional.
    }
  }
}


async function notifyBattleFinished(chatId: number | null | undefined, text: string) {
  if (!chatId || !Number.isSafeInteger(Number(chatId))) return;
  try {
    await telegramApi("sendMessage", {
      chat_id: Number(chatId),
      text,
      reply_markup: { inline_keyboard: [[{ text: "⚔️ Открыть итоги", url: miniAppLink(Number(chatId)) }]] },
    });
  } catch (error) {
    console.error("battle result telegram notification failed", error);
  }
}

async function resolveBattleRow(battle: any, attackerScore: number, defenderScore: number) {
  if (battle.status === "resolved") return battle;
  const supabase = getSupabaseAdmin();
  const scoreTotal = Math.max(1, attackerScore + defenderScore);
  const isDraw = Math.abs(attackerScore - defenderScore) / scoreTotal < 0.05;
  const attackerWon = !isDraw && attackerScore > defenderScore;

  const { data: result, error } = await supabase.rpc("gw_finalize_battle", {
    p_battle_id: battle.id,
    p_attacker_score: attackerScore,
    p_defender_score: defenderScore,
  });
  if (error) throw error;

  const { data: strategyResult, error: strategyError } = await supabase.rpc("gw_apply_battle_strategy_rewards", {
    p_battle_id: battle.id,
  });
  if (strategyError && strategyError.code !== "PGRST202") throw strategyError;

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
  const rewardError = rewardResults.find((item: any) => item.error)?.error;
  if (rewardError) throw rewardError;

  if (!result?.applied) return resolved;

  const islandBattle = (resolved as any).battle_kind === "island" || battle.battle_kind === "island";
  await addEvent(battle.id, null, "finish", {
    text: isDraw
      ? `Ничья ${attackerScore}:${defenderScore}. Обе стороны переходят к восстановлению.`
      : attackerWon
        ? (islandBattle ? `Атакующая сторона победила ${attackerScore}:${defenderScore}` : `Атакующие победили ${attackerScore}:${defenderScore}`)
        : (islandBattle ? `Защитники отбили атаку ${defenderScore}:${attackerScore}` : `Защита удержала сектор ${defenderScore}:${attackerScore}`),
  });
  const { data: namedStates, error: namedStatesError } = await supabase.from("states").select("id,name,telegram_chat_id,is_beginner_island").in("id", [battle.attacker_state_id, battle.defender_state_id].filter(Boolean));
  if (namedStatesError) throw namedStatesError;
  const attackerName = namedStates?.find((state: any) => state.id === battle.attacker_state_id)?.name || "Атакующие";
  const defenderName = namedStates?.find((state: any) => state.id === battle.defender_state_id)?.name || "Гарнизон";
  const destroyed = Boolean(result?.islandDestroyed);
  const integrityDamage = Number(result?.integrityDamage || 0);
  const defenderIntegrity = Number(result?.defenderIntegrity ?? 100);
  await recordWorldEvent({
    eventType: isDraw ? "battle_draw" : islandBattle
      ? (attackerWon ? (destroyed ? "island_destroyed" : "island_damaged") : "island_defended")
      : "battle_resolved",
    title: isDraw ? "Бой завершился ничьей" : islandBattle
      ? (attackerWon ? (destroyed ? "Государство разрушено" : "Территория повреждена") : "Оборона выдержала")
      : (attackerWon ? "Территория захвачена" : "Наступление отбито"),
    body: isDraw ? `${attackerName} и ${defenderName} завершили бой ${attackerScore}:${defenderScore}. Обе стороны несут расходы на восстановление.` : islandBattle
      ? (attackerWon
          ? (destroyed
              ? `${attackerName} добил оборону ${defenderName} ${attackerScore}:${defenderScore}. Государство понесло критические разрушения.`
              : `${attackerName} выиграл вторжение ${attackerScore}:${defenderScore} и снял ${integrityDamage}% прочности. У ${defenderName} осталось ${defenderIntegrity}%.`)
          : `${defenderName} отбил атаку ${attackerName}. Счёт ${defenderScore}:${attackerScore}.`)
      : (attackerWon
          ? `${attackerName} победил ${defenderName} со счётом ${attackerScore}:${defenderScore} и занял сектор.`
          : `${defenderName} удержал сектор против ${attackerName}. Счёт ${defenderScore}:${attackerScore}.`),
    actorStateId: isDraw ? null : attackerWon ? battle.attacker_state_id : battle.defender_state_id,
    targetStateId: isDraw ? null : attackerWon ? battle.defender_state_id : battle.attacker_state_id,
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
      lootCredits: Number(result?.lootCredits || 0) + Number(strategyResult?.stolenBudget || 0),
      stolenInfluence: Number(strategyResult?.stolenInfluence || 0),
    },
  });

  const attackerState = namedStates?.find((state: any) => state.id === battle.attacker_state_id);
  const defenderState = namedStates?.find((state: any) => state.id === battle.defender_state_id);
  const battleType = String((resolved as any).battle_type || battle.battle_type || "raid");
  const typeName = battleType === "siege" ? "ОСАДА" : battleType === "territory" ? "СПОР ЗА ТЕРРИТОРИЮ" : "РЕЙД";
  const outcome = isDraw
    ? `🤝 НИЧЬЯ · ${attackerScore}:${defenderScore}`
    : attackerWon
      ? `🏆 Победа: ${attackerName} · ${attackerScore}:${defenderScore}`
      : `🛡️ Победа: ${defenderName} · ${defenderScore}:${attackerScore}`;
  const lootBudget = Number(result?.lootCredits || 0) + Number(strategyResult?.stolenBudget || 0);
  const stolenInfluence = Number(strategyResult?.stolenInfluence || 0);
  const modifiers =
    `Размер: атака ×${Number(battle.attacker_size_modifier || 1).toFixed(2)} · оборона ×${Number(battle.defender_size_modifier || 1).toFixed(2)}\n` +
    `Underdog +${Math.round(Number(battle.underdog_bonus || 0) * 100)}% · буфер +${Math.round(Number(battle.defense_buffer_pct || 0) * 100)}% · усталость −${Math.round(Number(battle.aggression_penalty || 0) * 100)}%\n` +
    `Случайность: атака ×${Number(battle.attacker_random_modifier || 1).toFixed(2)} · оборона ×${Number(battle.defender_random_modifier || 1).toFixed(2)}`;
  const attackerLossPct = Math.round(Number(strategyResult?.attackerLossPct ?? battle.attacker_loss_pct ?? 0) * 100);
  const defenderLossPct = Math.round(Number(strategyResult?.defenderLossPct ?? battle.defender_loss_pct ?? 0) * 100);
  const rewards = isDraw
    ? "Обе стороны понесли расходы на восстановление. Захвата ресурсов нет."
    : `Захвачено: 💰 ${lootBudget.toLocaleString("ru-RU")} · влияние ${stolenInfluence.toLocaleString("ru-RU")}.`;
  const resultText = `⚔️ ${typeName} ЗАВЕРШЁН\n\n${attackerName} ${attackerScore}:${defenderScore} ${defenderName}\n${outcome}\n\n${modifiers}\nПотери: атакующие ${attackerLossPct}% · защитники ${defenderLossPct}%\n\n${rewards}`;

  await Promise.all([
    notifyBattleFinished(Number(attackerState?.telegram_chat_id || 0), resultText),
    notifyBattleFinished(Number(defenderState?.telegram_chat_id || 0), resultText),
  ]);

  const { data: trainingSupports, error: trainingSupportsError } = await supabase
    .from("battle_supports")
    .select("state_id,states!battle_supports_state_id_fkey(telegram_chat_id,name,is_beginner_island)")
    .eq("battle_id", battle.id);
  if (!trainingSupportsError) {
    const beginnerChats = new Map<number, string>();
    for (const support of trainingSupports || []) {
      const state: any = Array.isArray((support as any).states) ? (support as any).states[0] : (support as any).states;
      if (state?.is_beginner_island && Number.isSafeInteger(Number(state.telegram_chat_id))) beginnerChats.set(Number(state.telegram_chat_id), String(state.name || "Учебный округ"));
    }
    await Promise.all([...beginnerChats.entries()].map(([chatId, stateName]) =>
      notifyBattleFinished(chatId, `🗺️ Тренировочный бой завершён. ${stateName} потренировался в обороне. Получены опыт, репутация и вклад. Учебный округ не получает ресурсы из боя.`)
    ));
  }

  return resolved;
}

export async function resolveBattleByScore(battleId: string, attackerScore: number, defenderScore: number) {
  const supabase = getSupabaseAdmin();
  const { data: battle, error } = await supabase.from("battles").select("*").eq("id", battleId).single();
  if (error) throw error;
  return resolveBattleRow(requireData(battle, "Битва не найдена."), Math.max(0, Math.round(attackerScore)), Math.max(0, Math.round(defenderScore)));
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
    const attackerPoints = owners.filter((owner) => owner === "attacker").length;
    const defenderPoints = owners.filter((owner) => owner === "defender").length;
    const { data: supportRows, error: supportError } = await supabase.from("battle_supports").select("side,power_given").eq("battle_id", battleId);
    if (supportError && supportError.code !== "42P01") throw supportError;
    const attackerSupport = (supportRows || []).filter((row: any) => row.side === "attacker").reduce((sum: number, row: any) => sum + Number(row.power_given || 0), 0);
    const defenderSupport = (supportRows || []).filter((row: any) => row.side === "defender").reduce((sum: number, row: any) => sum + Number(row.power_given || 0), 0);
    const attackerRawPower = Math.max(1, Number(battleRow.attacker_raw_power || 1));
    const defenderRawPower = Math.max(1, Number(battleRow.defender_raw_power || 1));
    const attackerSupportModifier = 1 + Math.min(0.35, attackerSupport / attackerRawPower);
    const defenderSupportModifier = 1 + Math.min(0.35, defenderSupport / defenderRawPower);
    // Strategic power matters in realtime combat, but is deliberately bounded so
    // point control and player actions stay decisive instead of turning the fight
    // into a spreadsheet comparison before it even starts.
    const attackerPowerModifier = Math.max(0.80, Math.min(1.20, Math.sqrt(attackerRawPower / defenderRawPower)));
    const defenderPowerModifier = Math.max(0.80, Math.min(1.20, Math.sqrt(defenderRawPower / attackerRawPower)));
    const defenseBufferModifier = 1 + Math.max(0, Math.min(0.20, Number(battleRow.defense_buffer_pct || 0)));
    const attackerFatigueModifier = 1 - Math.max(0, Math.min(0.15, Number(battleRow.aggression_penalty || 0)));
    const attackerModifier = Math.max(0.70, Number(battleRow.attacker_size_modifier || 1)) * attackerFatigueModifier * Math.max(0.85, Number(battleRow.attacker_random_modifier || 1)) * attackerSupportModifier * attackerPowerModifier;
    const defenderModifier = Math.max(0.75, Number(battleRow.defender_size_modifier || 1)) * Math.max(0.85, Number(battleRow.defender_random_modifier || 1)) * defenderSupportModifier * defenderPowerModifier * defenseBufferModifier;
    attackerScore += Math.max(0, Math.round(attackerPoints * elapsedSeconds * attackerModifier));
    defenderScore += Math.max(0, Math.round(defenderPoints * elapsedSeconds * defenderModifier));
    const { data: ticked, error: tickError } = await supabase.from("battles").update({
      attacker_score: attackerScore,
      defender_score: defenderScore,
      last_tick_at: new Date(cappedNow).toISOString(),
    }).eq("id", battleId).eq("last_tick_at", battleRow.last_tick_at).select("*").maybeSingle();
    if (tickError) throw tickError;
    if (!ticked) {
      const { data: concurrent, error: concurrentError } = await supabase.from("battles").select("attacker_score,defender_score,last_tick_at").eq("id", battleId).single();
      if (concurrentError) throw concurrentError;
      attackerScore = concurrent?.attacker_score ?? attackerScore;
      defenderScore = concurrent?.defender_score ?? defenderScore;
    }
  }

  const { data: dead, error: deadError } = await supabase
    .from("battle_players")
    .select("id,player_id,team,players!battle_players_player_id_fkey(display_name)")
    .eq("battle_id", battleId)
    .eq("hp", 0)
    .lte("respawn_at", nowIso());
  if (deadError) throw deadError;
  for (const row of dead || []) {
    const { error: respawnError } = await supabase
      .from("battle_players")
      .update({ hp: 100, respawn_at: null, point: row.team === "defender" ? "C" : "A", updated_at: nowIso() })
      .eq("id", row.id);
    if (respawnError) throw respawnError;
    const player: any = row.players;
    await addEvent(battleId, row.player_id, "respawn", { name: player?.display_name || "Игрок" });
  }

  if (now >= end || (battleRow.battle_kind !== "island" && (attackerScore >= SCORE_TO_WIN || defenderScore >= SCORE_TO_WIN))) {
    return resolveBattleRow(battleRow, attackerScore, defenderScore);
  }

  const { data: refreshed, error: refreshedError } = await supabase.from("battles").select("*").eq("id", battleId).single();
  if (refreshedError) throw refreshedError;
  return refreshed || battleRow;
}

export async function joinBattle(battleId: string, playerId: string, stateId: string, klass: BattleClass = "assault") {
  const supabase = getSupabaseAdmin();
  const battle = await tickBattle(battleId);
  if (battle.status !== "active") throw new Error("Битва уже завершена.");
  const team: BattleTeam | null = stateId === battle.attacker_state_id ? "attacker" : stateId === battle.defender_state_id ? "defender" : null;
  if (!team) throw new Error("Ваше государство не участвует в этой битве.");

  const [playerRes, teamCountRes, existingRes] = await Promise.all([
    supabase.from("players").select("display_name").eq("id", playerId).single(),
    supabase.from("battle_players").select("id", { count: "exact", head: true }).eq("battle_id", battleId).eq("team", team),
    supabase.from("battle_players").select("id,squad_code,team").eq("battle_id", battleId).eq("player_id", playerId).maybeSingle(),
  ]);
  if (playerRes.error) throw playerRes.error;
  if (teamCountRes.error) throw teamCountRes.error;
  if (existingRes.error) throw existingRes.error;
  const player = playerRes.data;
  const teamCount = teamCountRes.count;
  const existingPlayer = existingRes.data;
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
  await recordMissionProgress(playerId, stateId, "join_battle");
  return getBattleView(battleId, playerId);
}

export async function battleAction(battleId: string, playerId: string, action: string, payload: any = {}) {
  const supabase = getSupabaseAdmin();

  if (action === "order") {
    const role = String(payload.role || "citizen");
    const stateId = String(payload.stateId || "");
    const point = payload.point as BattlePoint;
    const kind = payload.kind as BattleOrderKind;
    if (!["president", "minister", "deputy"].includes(role)) throw new Error("Отдавать приказы может президент или заместитель.");
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
    const { data: issuer, error: issuerError } = await supabase.from("players").select("display_name").eq("id", playerId).single();
    if (issuerError) throw issuerError;
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
    const { data: membership, error: membershipError } = await supabase.from("state_members").select("role").eq("player_id", playerId).in("state_id", stateIds).limit(1).maybeSingle();
    if (membershipError) throw membershipError;
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
    attackerSizeModifier: Number(battle.attacker_size_modifier || 1),
    defenderSizeModifier: Number(battle.defender_size_modifier || 1),
    defenderBuffer: Number(battle.defender_buffer || 0),
    aggressionPenalty: Number(battle.aggression_penalty || 0),
    battleType: battle.battle_type || "raid",
    attackerStateSize: Number(battle.attacker_state_size || 1),
    defenderStateSize: Number(battle.defender_state_size || 1),
    attackerRawPower: Number(battle.attacker_raw_power || 0),
    defenderRawPower: Number(battle.defender_raw_power || 0),
    attackerFinalPower: Number(battle.attacker_final_power || 0),
    defenderFinalPower: Number(battle.defender_final_power || 0),
    underdogBonus: Number(battle.underdog_bonus || 0),
    defenseBufferPct: Number(battle.defense_buffer_pct || 0),
    attackerRandomModifier: Number(battle.attacker_random_modifier || 1),
    defenderRandomModifier: Number(battle.defender_random_modifier || 1),
    stolenBudget: Number(battle.stolen_budget || 0),
    stolenInfluence: Number(battle.stolen_influence || 0),
    pointOwners: {
      A: battle.point_a_owner,
      B: battle.point_b_owner,
      C: battle.point_c_owner,
    },
    winnerStateId: battle.winner_state_id,
    isDraw: Boolean(battle.is_draw),
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
    .select("id,starts_at,ends_at,status")
    .in("status", ["scheduled", "active"])
    .or(`attacker_state_id.eq.${stateId},defender_state_id.eq.${stateId}`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;

  for (const row of data || []) {
    const endsAt = new Date(row.ends_at).getTime();
    if (Number.isFinite(endsAt) && endsAt <= Date.now()) {
      await tickBattle(String(row.id));
      continue;
    }
    const view = await getBattleView(String(row.id), playerId);
    if (view.status === "active") return view;
    if (view.status === "scheduled" && new Date(view.startsAt).getTime() > Date.now()) return view;
  }
  return null;
}
