import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";
import { tryCommandCooldown } from "@/lib/cooldown";

const MAX_MESSAGE_LENGTH = 1600;
const DIVIDER = "────────────";

type StateRoute = {
  id: string;
  name: string;
  state_username: string | null;
  telegram_chat_id: number | null;
  bot_present?: boolean | null;
  is_freeport?: boolean | null;
};

type SendStateMessageInput = {
  sourceStateId: string;
  sourceStateName: string;
  sourceStateUsername?: string | null;
  sourceChatId: number;
  sourcePlayerId?: string | null;
  sourcePlayerName: string;
  targetUsername: string;
  text: string;
  sourceMessageId?: number | null;
};

function normalizeHandle(value: string) {
  return String(value || "").trim().replace(/^@/, "").toLocaleLowerCase("ru-RU");
}

function normalizeText(value: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Введите текст сообщения после юза государства.");
  if (text.length > MAX_MESSAGE_LENGTH) throw new Error(`Сообщение слишком длинное. Максимум ${MAX_MESSAGE_LENGTH} символов.`);
  return text;
}

function stateLabel(state: Pick<StateRoute, "name" | "state_username">) {
  return state.state_username ? `${state.name} (@${state.state_username})` : state.name;
}

async function resolveTargetState(username: string): Promise<StateRoute> {
  const handle = normalizeHandle(username);
  if (!handle) throw new Error("Укажите юз государства, например: !соо @north текст сообщения");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select("id,name,state_username,telegram_chat_id,bot_present,is_freeport")
    .ilike("state_username", handle)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Государство @${handle} не найдено.`);
  if (data.is_freeport) throw new Error("Нейтральная зона не принимает межгосударственные сообщения.");
  if (data.bot_present === false || !data.telegram_chat_id) throw new Error(`Бот сейчас не подключён к чату государства @${handle}.`);
  return data as StateRoute;
}

async function createPendingRoute(input: {
  sourceStateId: string;
  targetStateId: string;
  sourcePlayerId?: string | null;
  sourceChatId: number;
  targetChatId: number;
  sourceMessageId?: number | null;
  text: string;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_messages")
    .insert({
      source_state_id: input.sourceStateId,
      target_state_id: input.targetStateId,
      source_player_id: input.sourcePlayerId || null,
      source_chat_id: input.sourceChatId,
      target_chat_id: input.targetChatId,
      source_message_id: input.sourceMessageId || null,
      target_message_id: null,
      message_text: input.text,
    })
    .select("id")
    .single();
  if (error) {
    if (["42P01", "PGRST205"].includes(String((error as { code?: string }).code || ""))) {
      throw new Error("Сначала примените миграцию 039_interstate_messages.sql.");
    }
    throw error;
  }
  return String(data.id);
}

async function finalizeRoute(id: string, targetMessageId: number) {
  const supabase = getSupabaseAdmin();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.from("state_messages").update({ target_message_id: targetMessageId }).eq("id", id);
    if (!error) return;
    lastError = error;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Не удалось сохранить маршрут межгосударственного сообщения.");
}

async function removePendingRoute(id: string) {
  const supabase = getSupabaseAdmin();
  try {
    const { error } = await supabase.from("state_messages").delete().eq("id", id).is("target_message_id", null);
    if (error) console.warn("WARSTATE pending interstate route cleanup failed", error);
  } catch (error) {
    console.warn("WARSTATE pending interstate route cleanup failed", error);
  }
}

export async function sendInterstateMessage(input: SendStateMessageInput) {
  const target = await resolveTargetState(input.targetUsername);
  if (String(target.id) === String(input.sourceStateId)) throw new Error("Нельзя отправить межгосударственное сообщение самому себе.");
  const text = normalizeText(input.text);
  const targetChatId = Number(target.telegram_chat_id);
  const routeId = await createPendingRoute({
    sourceStateId: input.sourceStateId,
    targetStateId: target.id,
    sourcePlayerId: input.sourcePlayerId,
    sourceChatId: input.sourceChatId,
    targetChatId,
    sourceMessageId: input.sourceMessageId,
    text,
  });

  try {
    const sent = await telegramApi<{ message_id: number }>("sendMessage", {
      chat_id: targetChatId,
      text:
        `📨 МЕЖГОСУДАРСТВЕННОЕ СООБЩЕНИЕ\n${DIVIDER}\n` +
        `От: ${input.sourceStateName}${input.sourceStateUsername ? ` (@${input.sourceStateUsername})` : ""}\n` +
        `Передал: ${input.sourcePlayerName}\n\n` +
        `${text}\n\n` +
        `Ответьте на это сообщение через Reply, чтобы отправить ответ государству-отправителю.`,
      link_preview_options: { is_disabled: true },
    });
    await finalizeRoute(routeId, Number(sent.message_id));
    return { targetName: target.name, targetUsername: target.state_username, targetMessageId: Number(sent.message_id) };
  } catch (error) {
    await removePendingRoute(routeId);
    throw error;
  }
}

function replyText(message: any) {
  return String(message?.text || message?.caption || "").trim();
}

export async function handleInterstateReply(message: any): Promise<boolean> {
  if (message?.from?.is_bot) return false;
  const chatId = Number(message?.chat?.id || 0);
  const replyMessageId = Number(message?.reply_to_message?.message_id || 0);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(replyMessageId) || !replyMessageId) return false;

  const supabase = getSupabaseAdmin();
  const { data: route, error } = await supabase
    .from("state_messages")
    .select("id,source_state_id,target_state_id,source_chat_id,target_chat_id,message_text")
    .eq("target_chat_id", chatId)
    .eq("target_message_id", replyMessageId)
    .maybeSingle();
  if (error) {
    if (["42P01", "PGRST205"].includes(String((error as { code?: string }).code || ""))) return false;
    throw error;
  }
  if (!route) return false;

  const senderId = Number(message?.from?.id || 0);
  if (Number.isSafeInteger(senderId) && senderId > 0 && !(await tryCommandCooldown(chatId, senderId, "interstate_reply", 4))) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: Number(message.message_id),
      text: "Ответы можно отправлять не чаще одного раза в 4 секунды.",
    }).catch(() => undefined);
    return true;
  }

  const text = replyText(message);
  if (!text) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: Number(message.message_id),
      text: "Для межгосударственного ответа отправьте текст или подпись к сообщению.",
    }).catch(() => undefined);
    return true;
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: Number(message.message_id),
      text: `Ответ слишком длинный. Максимум ${MAX_MESSAGE_LENGTH} символов.`,
    }).catch(() => undefined);
    return true;
  }

  const [{ data: replyingState, error: stateError }, { data: player, error: playerError }] = await Promise.all([
    supabase.from("states").select("id,name,state_username,telegram_chat_id,bot_present").eq("id", route.target_state_id).single(),
    message?.from?.id
      ? supabase.from("players").select("id,display_name,username").eq("telegram_id", Number(message.from.id)).maybeSingle()
      : Promise.resolve({ data: null, error: null } as any),
  ]);
  if (stateError) throw stateError;
  if (playerError) console.warn("WARSTATE interstate reply author lookup failed", playerError);
  if (!replyingState || Number(replyingState.telegram_chat_id) !== chatId) return false;

  const sourceChatId = Number(route.source_chat_id);
  const replyAuthor = player?.display_name || String(message?.from?.first_name || "Участник государства");
  const pendingId = await createPendingRoute({
    sourceStateId: String(route.target_state_id),
    targetStateId: String(route.source_state_id),
    sourcePlayerId: player?.id ? String(player.id) : null,
    sourceChatId: chatId,
    targetChatId: sourceChatId,
    sourceMessageId: Number(message.message_id || 0) || null,
    text,
  });

  try {
    const sent = await telegramApi<{ message_id: number }>("sendMessage", {
      chat_id: sourceChatId,
      text:
        `📨 ОТВЕТ ГОСУДАРСТВА\n${DIVIDER}\n` +
        `От: ${stateLabel(replyingState as StateRoute)}\n` +
        `Передал: ${replyAuthor}\n\n` +
        `${text}\n\n` +
        `Ответьте через Reply, чтобы продолжить переписку.`,
      link_preview_options: { is_disabled: true },
    });
    await finalizeRoute(pendingId, Number(sent.message_id));
    await telegramApi("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: Number(message.message_id),
      text: "Ответ отправлен государству.",
    }).catch(() => undefined);
    return true;
  } catch (sendError) {
    await removePendingRoute(pendingId);
    throw sendError;
  }
}
