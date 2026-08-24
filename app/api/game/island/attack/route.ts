import { createStateVote } from "@/lib/community";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";
import type { WarType } from "@/lib/types";

export const runtime = "nodejs";

function voteKeyboard(voteId: string) {
  return [[
    { text: "✅ За", callback_data: `gw:vote:yes:${voteId}` },
    { text: "❌ Против", callback_data: `gw:vote:no:${voteId}` },
  ]];
}

function warLabel(type: WarType) {
  return type === "siege" ? "осаду" : type === "territory" ? "войну за территорию" : "рейд";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const targetStateId = String(body.targetStateId || "");
    const battleType = (["raid", "siege", "territory"].includes(String(body.battleType)) ? String(body.battleType) : "raid") as WarType;
    if (!stateId || !targetStateId) throw new Error("stateId and targetStateId are required");

    const { player, member, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (state.is_freeport) throw new Error("Freeport не может начинать войну.");
    if (state.is_beginner_island) throw new Error("Остров новичков не может начинать войну.");
    if (member.role !== "president") throw new Error("Голосование о начале войны запускает Президент.");

    const supabase = getSupabaseAdmin();
    const { data: states, error: statesError } = await supabase
      .from("states")
      .select("id,name,telegram_chat_id,is_freeport,is_beginner_island")
      .in("id", [stateId, targetStateId]);
    if (statesError) throw statesError;
    const attacker = states?.find((row: any) => String(row.id) === stateId);
    const defender = states?.find((row: any) => String(row.id) === targetStateId);
    if (!attacker || !defender) throw new Error("Государство не найдено.");
    if (defender.is_freeport) throw new Error("Freeport — нейтральная территория.");
    if (defender.is_beginner_island) throw new Error("Остров новичков находится под защитой.");
    if (!attacker.telegram_chat_id) throw new Error("У государства отсутствует Telegram-чат для голосования.");

    const vote = await createStateVote({
      stateId,
      createdByPlayerId: player.id,
      kind: "war",
      targetStateId,
      payload: { battleType },
    });

    await telegramApi("sendMessage", {
      chat_id: Number(attacker.telegram_chat_id),
      text: `🗳 ГОЛОСОВАНИЕ О ВОЙНЕ\n\nНачать ${warLabel(battleType)} против «${defender.name}»?\nГолосуют граждане государства. Срок: 10 минут. При абсолютном большинстве решение исполняется досрочно.`,
      reply_markup: { inline_keyboard: voteKeyboard(vote.id) },
    });

    return Response.json({ voteId: vote.id, endsAt: vote.ends_at, voteStarted: true });
  } catch (error) {
    return jsonError(error);
  }
}
