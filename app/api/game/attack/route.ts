import { createBattle } from "@/lib/battle";
import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const tileId = String(body.tileId || "");
    if (!stateId || !tileId) throw new Error("stateId and tileId are required");
    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!["president", "minister", "general"].includes(member.role)) throw new Error("Операцию может начать президент, министр или генерал.");
    const battle = await createBattle(stateId, tileId);

    const supabase = getSupabaseAdmin();
    const { data: states } = await supabase.from("states").select("id,telegram_chat_id,name").in("id", [battle.attackerStateId, battle.defenderStateId].filter(Boolean) as string[]);
    for (const state of states || []) {
      await telegramApi("sendMessage", {
        chat_id: Number(state.telegram_chat_id),
        text: `⚔️ БИТВА НАЧАЛАСЬ\n\n${battle.attackerName} vs ${battle.defenderName}\nСектор: ${(battle.tileId || "unknown").slice(0, 8)}\nВремя: 3 минуты\n\nЗахватывайте A/B/C и удерживайте точки.`,
        reply_markup: { inline_keyboard: [[{ text: "⚔️ Войти в бой", url: miniAppLink(Number(state.telegram_chat_id)) }]] },
      }).catch(() => null);
    }

    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, battle });
  } catch (error) {
    return jsonError(error);
  }
}
