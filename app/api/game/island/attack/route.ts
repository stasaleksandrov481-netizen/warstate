import { getBattleView } from "@/lib/battle";
import { createIslandBattle } from "@/lib/islands";
import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { recordWorldEvent } from "@/lib/diplomacy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const targetStateId = String(body.targetStateId || "");
    if (!stateId || !targetStateId) throw new Error("stateId and targetStateId are required");

    const { player, member, session, state: authState } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (authState.is_freeport) throw new Error("Freeport — нейтральная территория. Сначала вступите в государство.");
    if (!["president", "minister", "general"].includes(member.role)) {
      throw new Error("Морскую атаку может начать президент, министр или генерал.");
    }

    const battleId = await createIslandBattle(stateId, targetStateId);
    const battle = await getBattleView(battleId, player.id);
    const supabase = getSupabaseAdmin();
    const { data: states, error: statesError } = await supabase
      .from("states")
      .select("id,telegram_chat_id,name")
      .in("id", [stateId, targetStateId]);
    if (statesError) throw statesError;

    const attacker = states?.find((row: any) => row.id === stateId);
    const defender = states?.find((row: any) => row.id === targetStateId);
    const text = `⚔️ АТАКА НА ОСТРОВ\n\n${attacker?.name || "Атакующие"} vs ${defender?.name || "Защитники"}\nВремя: 3 минуты\n\nЗахватывайте A/B/C. Победитель получает ELO, а проигравший остров может уйти в руины.`;
    for (const state of states || []) {
      await telegramApi("sendMessage", {
        chat_id: Number(state.telegram_chat_id),
        text,
        reply_markup: { inline_keyboard: [[{ text: "⚔️ Войти в бой", url: miniAppLink(Number(state.telegram_chat_id)) }]] },
      }).catch((error) => console.error("island Telegram notification failed", error));
    }

    await recordWorldEvent({
      eventType: "island_attack",
      title: "Морская атака",
      body: `${attacker?.name || "Остров"} атакует ${defender?.name || "другой остров"}.`,
      actorStateId: stateId,
      targetStateId,
      payload: { battleId },
    });

    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, battle });
  } catch (error) {
    return jsonError(error);
  }
}
