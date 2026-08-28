import { createStateVote } from "@/lib/community";
import { getDiplomacyForState, performDiplomacyAction } from "@/lib/diplomacy";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import type { DiplomacyAction } from "@/lib/types";

export const runtime = "nodejs";

const ACTIONS: DiplomacyAction[] = ["propose_alliance", "accept_alliance", "reject_alliance", "declare_war", "offer_truce", "accept_truce", "break_alliance"];

const COPY: Partial<Record<DiplomacyAction, { title: string; line: string }>> = {
  reject_alliance: { title: "✋ СОЮЗ ОТКЛОНЁН", line: "отклонил предложение союза" },
  offer_truce: { title: "🕊 ПРЕДЛОЖЕНО ПЕРЕМИРИЕ", line: "предлагает прекратить огонь" },
  accept_truce: { title: "🕊 ПЕРЕМИРИЕ", line: "принял перемирие" },
  break_alliance: { title: "💔 СОЮЗ РАЗОРВАН", line: "вышел из союза" },
};

function voteKeyboard(voteId: string) {
  return [[
    { text: "✅ За", callback_data: `gw:vote:yes:${voteId}` },
    { text: "❌ Против", callback_data: `gw:vote:no:${voteId}` },
  ]];
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const targetStateId = String(body.targetStateId || "");
    const action = String(body.action || "") as DiplomacyAction;
    if (!stateId || !targetStateId || !ACTIONS.includes(action)) throw new Error("Некорректная дипломатическая команда.");

    const { player, member, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (state.is_freeport) throw new Error("Freeport сохраняет нейтралитет и не участвует в дипломатии.");
    if (member.role === "curator" && !state.is_beginner_island) throw new Error("Роль куратора действует только в государстве новичков.");

    const supabase = getSupabaseAdmin();
    const { data: states, error: statesError } = await supabase
      .from("states")
      .select("id,name,state_username,telegram_chat_id,is_freeport")
      .in("id", [stateId, targetStateId]);
    if (statesError) throw statesError;
    const actor = states?.find((row: any) => String(row.id) === stateId);
    const target = states?.find((row: any) => String(row.id) === targetStateId);
    if (!actor || !target) throw new Error("Государство не найдено.");
    if (target.is_freeport) throw new Error("Freeport — нейтральная территория и не участвует в дипломатии.");

    if (action === "declare_war") {
      throw new Error("Война начинается только через голосование. Выберите цель на карте и запустите атаку Президентом.");
    }

    if (action === "propose_alliance" || action === "accept_alliance") {
      const isDiplomat = member.duty_role === "diplomat";
      if (member.role !== "president" && !isDiplomat) throw new Error("Голосование о союзе запускает Президент или Дипломат.");
      if (!actor.telegram_chat_id) throw new Error("У государства отсутствует Telegram-чат для голосования.");

      if (action === "accept_alliance") {
        const relations = await getDiplomacyForState(stateId);
        const pending = relations.find((item) => item.otherStateId === targetStateId && item.status === "alliance_pending" && item.requestedByStateId !== stateId);
        if (!pending) throw new Error("Нет входящего предложения союза от этого государства.");
      }

      const vote = await createStateVote({
        stateId,
        createdByPlayerId: player.id,
        kind: "alliance",
        targetStateId,
        payload: { action: action === "accept_alliance" ? "accept" : "propose" },
      });
      await telegramApi("sendMessage", {
        chat_id: Number(actor.telegram_chat_id),
        text: `🗳 ГОЛОСОВАНИЕ О СОЮЗЕ\n\n${action === "accept_alliance" ? "Заключить" : "Предложить"} союз с «${target.name}»?\nГолосуют граждане государства. Срок: 10 минут.`,
        reply_markup: { inline_keyboard: voteKeyboard(vote.id) },
      });
      return Response.json({ diplomacy: await getDiplomacyForState(stateId), voteId: vote.id, voteStarted: true });
    }

    const canManageDiplomacy = member.role === "president" || member.role === "minister" || member.role === "deputy" || member.role === "curator" || member.duty_role === "diplomat";
    if (!canManageDiplomacy) throw new Error("Дипломатией управляет Президент, Дипломат или заместитель.");

    const diplomacy = await performDiplomacyAction(stateId, targetStateId, action);
    const copy = COPY[action];
    if (copy) {
      for (const targetChat of [actor, target]) {
        if (targetChat.is_freeport || !targetChat.telegram_chat_id) continue;
        await telegramApi("sendMessage", {
          chat_id: Number(targetChat.telegram_chat_id),
          text: `${copy.title}\n\n${actor.name} ${copy.line} ${target.name}.\n\nОткройте мировой экран, чтобы увидеть текущий статус отношений.`,
          reply_markup: { inline_keyboard: [[{ text: "🌍 Открыть мир", url: miniAppLink(Number(targetChat.telegram_chat_id)) }]] },
        }).catch((error) => console.error("diplomacy Telegram notification failed", error));
      }
    }

    return Response.json({ diplomacy });
  } catch (error) {
    return jsonError(error);
  }
}
