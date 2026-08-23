import { getBattleView } from "@/lib/battle";
import { createIslandBattle } from "@/lib/islands";
import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { getAlliedStateChats, recordWorldEvent } from "@/lib/diplomacy";
import type { WarType } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const targetStateId = String(body.targetStateId || "");
    const battleType = (["raid", "siege", "territory"].includes(String(body.battleType)) ? String(body.battleType) : "raid") as WarType;
    if (!stateId || !targetStateId) throw new Error("stateId and targetStateId are required");

    const { player, member, session, state: authState } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (authState.is_freeport) throw new Error("Freeport — нейтральная территория. Сначала вступите в государство.");
    if (!["president", "minister", "deputy"].includes(member.role)) {
      throw new Error("Морскую атаку может начать президент или заместитель.");
    }

    const battleId = await createIslandBattle(stateId, targetStateId, battleType);
    const battle = await getBattleView(battleId, player.id);
    const supabase = getSupabaseAdmin();
    const { data: states, error: statesError } = await supabase
      .from("states")
      .select("id,telegram_chat_id,name")
      .in("id", [stateId, targetStateId]);
    if (statesError) throw statesError;

    const attacker = states?.find((row: any) => row.id === stateId);
    const defender = states?.find((row: any) => row.id === targetStateId);
    const typeLabel = battleType === "siege" ? "ОСАДА" : battleType === "territory" ? "СПОР ЗА ТЕРРИТОРИЮ" : "РЕЙД";
    const minutes = battleType === "siege" ? 30 : battleType === "territory" ? 20 : 15;
    const text = `⚔️ ${typeLabel}\n\n${attacker?.name || "Атакующие"} vs ${defender?.name || "Защитники"}\nВремя: ${minutes} мин.\n\nЗахватывайте A/B/C. Размер государств, оборонительный буфер, усталость, случайный фактор и союзная поддержка входят в расчёт.`;
    for (const state of states || []) {
      const isDefender = String(state.id) === targetStateId;
      await telegramApi("sendMessage", {
        chat_id: Number(state.telegram_chat_id),
        text,
        reply_markup: { inline_keyboard: isDefender ? [
          [{ text: "🛡️ Организовать оборону", url: miniAppLink(Number(state.telegram_chat_id)) }],
          [{ text: "🤝 Запросить союзную помощь", callback_data: `gw:battle:support:${battleId}` }],
          [{ text: "🏳 Сдаться", callback_data: `gw:battle:surrender:${battleId}` }],
        ] : [[{ text: "⚔️ Войти в бой", url: miniAppLink(Number(state.telegram_chat_id)) }]] },
      }).catch((error) => console.error("island Telegram notification failed", error));
    }

    const [attackerAllies, defenderAllies] = await Promise.all([getAlliedStateChats(stateId), getAlliedStateChats(targetStateId)]);
    const supportNotices = [
      ...attackerAllies.map((ally: { id: string; name: string; telegramChatId: number }) => ({ ...ally, side: "attack" as const, requester: attacker?.name || "Союзник", enemy: defender?.name || "противник" })),
      ...defenderAllies.map((ally: { id: string; name: string; telegramChatId: number }) => ({ ...ally, side: "defense" as const, requester: defender?.name || "Союзник", enemy: attacker?.name || "противник" })),
    ];
    for (const ally of supportNotices) {
      await telegramApi("sendMessage", {
        chat_id: ally.telegramChatId,
        text: `🤝 СОЮЗНЫЙ ЗАПРОС\n\n${ally.requester} просит поддержки в бою против ${ally.enemy}.\nВыберите действие или используйте команду !поддержать ${battleId} ${ally.side}.`,
        reply_markup: { inline_keyboard: [
          [ally.side === "defense"
            ? { text: "🛡️ Помочь защитой", callback_data: `gw:support:defender:${battleId}` }
            : { text: "⚔️ Помочь атакой", callback_data: `gw:support:attacker:${battleId}` }],
          [{ text: "Пропустить", callback_data: `gw:support:skip:${battleId}` }],
          [{ text: "Открыть бой", url: miniAppLink(ally.telegramChatId) }],
        ] },
      }).catch((error) => console.error("ally battle notification failed", error));
    }

    await recordWorldEvent({
      eventType: "island_attack",
      title: "Морская атака",
      body: `${attacker?.name || "Остров"} атакует ${defender?.name || "другой остров"}.`,
      actorStateId: stateId,
      targetStateId,
      payload: { battleId, battleType },
    });

    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, battle });
  } catch (error) {
    return jsonError(error);
  }
}
