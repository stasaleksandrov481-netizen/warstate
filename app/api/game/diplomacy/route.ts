import { performDiplomacyAction } from "@/lib/diplomacy";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import type { DiplomacyAction } from "@/lib/types";

export const runtime = "nodejs";

const ACTIONS: DiplomacyAction[] = ["propose_alliance", "accept_alliance", "reject_alliance", "declare_war", "offer_truce", "accept_truce", "break_alliance"];

const COPY: Record<DiplomacyAction, { title: string; line: string }> = {
  propose_alliance: { title: "🤝 ПРЕДЛОЖЕНИЕ СОЮЗА", line: "предлагает заключить союз" },
  accept_alliance: { title: "🤝 СОЮЗ ЗАКЛЮЧЁН", line: "принял предложение союза" },
  reject_alliance: { title: "✋ СОЮЗ ОТКЛОНЁН", line: "отклонил предложение союза" },
  declare_war: { title: "⚔️ ОБЪЯВЛЕНА ВОЙНА", line: "объявил войну" },
  offer_truce: { title: "🕊 ПРЕДЛОЖЕНО ПЕРЕМИРИЕ", line: "предлагает прекратить огонь" },
  accept_truce: { title: "🕊 ПЕРЕМИРИЕ", line: "принял перемирие" },
  break_alliance: { title: "💔 СОЮЗ РАЗОРВАН", line: "вышел из союза" },
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const targetStateId = String(body.targetStateId || "");
    const action = String(body.action || "") as DiplomacyAction;
    if (!stateId || !targetStateId || !ACTIONS.includes(action)) throw new Error("Некорректная дипломатическая команда.");
    const { member, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (state.is_freeport) throw new Error("Freeport сохраняет нейтралитет и не участвует в дипломатии.");
    if (!["president", "minister", "deputy", "curator"].includes(member.role)) throw new Error("Дипломатией управляет президент, заместитель или куратор Острова новичков.");
    if (state.is_beginner_island && action === "declare_war") throw new Error("Остров новичков не может объявлять войну.");
    if (member.role === "curator" && !state.is_beginner_island) throw new Error("Роль куратора действует только на Острове новичков.");

    const supabase = getSupabaseAdmin();
    const { data: targetState, error: targetError } = await supabase.from("states").select("is_freeport").eq("id", targetStateId).single();
    if (targetError || !targetState) throw new Error("Государство не найдено.");
    if (targetState.is_freeport) throw new Error("Freeport — нейтральная территория и не участвует в дипломатии.");

    const diplomacy = await performDiplomacyAction(stateId, targetStateId, action);

    const { data: states, error: statesError } = await supabase.from("states").select("id,name,telegram_chat_id,is_freeport").in("id", [stateId, targetStateId]);
    if (statesError) throw statesError;
    const actor = states?.find((state: any) => state.id === stateId);
    const target = states?.find((state: any) => state.id === targetStateId);
    const copy = COPY[action];
    if (actor && target) {
      for (const state of [actor, target]) {
        if (state.is_freeport || !state.telegram_chat_id) continue;
        await telegramApi("sendMessage", {
          chat_id: Number(state.telegram_chat_id),
          text: `${copy.title}\n\n${actor.name} ${copy.line} ${target.name}.\n\nОткройте мировой экран, чтобы увидеть текущий статус отношений.`,
          reply_markup: { inline_keyboard: [[{ text: "🌍 Открыть мир", url: miniAppLink(Number(state.telegram_chat_id)) }]] },
        }).catch((error) => console.error("diplomacy Telegram notification failed", error));
      }
    }

    return Response.json({ diplomacy });
  } catch (error) {
    return jsonError(error);
  }
}
