import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getChat, getChatMember, telegramApi } from "@/lib/telegram-bot";

export type AdminRewardType =
  | "resource"
  | "military_boost"
  | "protection"
  | "prestige"
  | "title"
  | "medal"
  | "treasury"
  | "xp_boost"
  | "starter_pack"
  | "reputation"
  | "influence";

export interface AdminStateTarget {
  id: string;
  name: string;
  stateUsername: string | null;
  telegramChatId: number;
  telegramChatUsername: string | null;
  botPresent: boolean;
  memberCount: number;
  rating: number;
}

export interface AdminMemberTarget {
  id: string;
  displayName: string;
  username: string | null;
  role: string;
}

export interface AdminHistoryRow {
  id: string;
  adminTelegramId: number;
  adminUsername: string | null;
  stateId: string;
  stateName: string;
  playerId: string | null;
  playerName: string | null;
  actionType: "reward" | "message";
  rewardType: string | null;
  amount: number;
  parameters: Record<string, unknown>;
  reason: string | null;
  messageText: string | null;
  createdAt: string;
}

const REWARD_META: Record<AdminRewardType, { icon: string; label: string }> = {
  resource: { icon: "💰", label: "Ресурсы" },
  military_boost: { icon: "⚔️", label: "Военный буст" },
  protection: { icon: "🛡", label: "Защита от ЧП" },
  prestige: { icon: "🏆", label: "Престиж" },
  title: { icon: "🎖", label: "Титул" },
  medal: { icon: "🏅", label: "Медаль" },
  treasury: { icon: "🎁", label: "Казна пополнена" },
  xp_boost: { icon: "⭐", label: "Буст опыта" },
  starter_pack: { icon: "🚀", label: "Стартовый набор" },
  reputation: { icon: "◆", label: "Репутация" },
  influence: { icon: "◈", label: "Влияние" },
};

function safeAdminUsername(value: string | null | undefined) {
  return String(value || "").trim().replace(/^@/, "").slice(0, 64) || null;
}

function adminLabel(telegramId: number, username?: string | null) {
  const safe = safeAdminUsername(username);
  return safe ? `@${safe}` : `ID ${telegramId}`;
}

const RESOURCE_LABELS: Record<string, string> = { credits: "Кредиты", steel: "Сталь", fuel: "Топливо", food: "Продовольствие", tech: "Технологии" };

function rewardValue(type: AdminRewardType, resultLabel: string, amount: number, parameters: Record<string, unknown>, playerName?: string | null) {
  if (type === "resource") return `${RESOURCE_LABELS[String(parameters.resource || "credits")] || "Ресурс"} +${amount.toLocaleString("ru-RU")}`;
  if (type === "treasury") return `+${amount.toLocaleString("ru-RU")} кредитов`;
  if (type === "prestige") return `+${amount.toLocaleString("ru-RU")} очков`;
  if (type === "reputation") return `+${amount.toLocaleString("ru-RU")}`;
  if (type === "influence") return `+${amount.toLocaleString("ru-RU")}`;
  if (type === "title") return `${String(parameters.title || resultLabel)}${playerName ? ` · ${playerName}` : ""}`;
  if (type === "medal") return `${String(parameters.title || resultLabel)}${playerName ? ` · ${playerName}` : ""}`;
  return resultLabel;
}

function clampText(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}

export async function searchAdminStates(query = "", limit = 60): Promise<AdminStateTarget[]> {
  const supabase = getSupabaseAdmin();
  const q = clampText(query, 40).replace(/^@/, "");
  let builder = supabase
    .from("states")
    .select("id,name,state_username,telegram_chat_id,telegram_chat_username,bot_present,telegram_member_count,rating")
    .eq("is_freeport", false)
    .not("telegram_chat_id", "is", null)
    .order("name", { ascending: true })
    .limit(Math.max(1, Math.min(100, limit)));
  if (q) {
    const safe = q.replace(/[^a-zA-Z0-9_а-яА-ЯёЁ -]/g, "");
    builder = builder.or(`name.ilike.%${safe}%,state_username.ilike.%${safe}%`);
  }
  const { data, error } = await builder;
  if (error) throw error;
  return (data || []).map((row: any) => ({
    id: String(row.id),
    name: String(row.name || "Государство"),
    stateUsername: row.state_username ? String(row.state_username) : null,
    telegramChatId: Number(row.telegram_chat_id),
    telegramChatUsername: row.telegram_chat_username ? String(row.telegram_chat_username) : null,
    botPresent: row.bot_present !== false,
    memberCount: Math.max(0, Number(row.telegram_member_count || 0)),
    rating: Math.max(0, Number(row.rating || 0)),
  }));
}

export async function searchAdminStateMembers(stateId: string, query = "", limit = 40): Promise<AdminMemberTarget[]> {
  const supabase = getSupabaseAdmin();
  const q = clampText(query, 40).replace(/^@/, "");
  const safeLimit = Math.max(1, Math.min(100, limit));

  // With a search query, resolve matching players first and only then intersect
  // them with citizenship. The previous implementation fetched an arbitrary
  // first page of state_members and could never find citizens outside it.
  if (q) {
    const safe = q.replace(/[^a-zA-Z0-9_а-яА-ЯёЁ -]/g, "");
    const { data: players, error: playerError } = await supabase
      .from("players")
      .select("id,display_name,username")
      .or(`display_name.ilike.%${safe}%,username.ilike.%${safe}%`)
      .limit(safeLimit);
    if (playerError) throw playerError;
    const ids = (players || []).map((row: any) => String(row.id));
    if (!ids.length) return [];
    const { data: memberships, error: memberError } = await supabase
      .from("state_members")
      .select("player_id,role")
      .eq("state_id", stateId)
      .in("player_id", ids);
    if (memberError) throw memberError;
    const roles = new Map((memberships || []).map((row: any) => [String(row.player_id), String(row.role || "citizen")]));
    return (players || [])
      .filter((row: any) => roles.has(String(row.id)))
      .map((row: any) => ({
        id: String(row.id),
        displayName: String(row.display_name || "Игрок"),
        username: row.username ? String(row.username) : null,
        role: roles.get(String(row.id)) || "citizen",
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "ru"));
  }

  const { data: memberships, error: memberError } = await supabase
    .from("state_members")
    .select("player_id,role")
    .eq("state_id", stateId)
    .limit(safeLimit);
  if (memberError) throw memberError;
  const ids = (memberships || []).map((row: any) => String(row.player_id));
  if (!ids.length) return [];
  const { data: players, error: playerError } = await supabase
    .from("players")
    .select("id,display_name,username")
    .in("id", ids)
    .limit(safeLimit);
  if (playerError) throw playerError;
  const roles = new Map((memberships || []).map((row: any) => [String(row.player_id), String(row.role || "citizen")]));
  return (players || []).map((row: any) => ({
    id: String(row.id),
    displayName: String(row.display_name || "Игрок"),
    username: row.username ? String(row.username) : null,
    role: roles.get(String(row.id)) || "citizen",
  })).sort((a, b) => a.displayName.localeCompare(b.displayName, "ru"));
}

export async function getAdminRewardHistory(stateId?: string | null, limit = 60): Promise<AdminHistoryRow[]> {
  const supabase = getSupabaseAdmin();
  let builder = supabase
    .from("admin_reward_log")
    .select("id,admin_telegram_id,admin_username,state_id,player_id,action_type,reward_type,amount,parameters,reason,message_text,created_at,states(name),players(display_name)")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (stateId) builder = builder.eq("state_id", stateId);
  const { data, error } = await builder;
  if (error) {
    if (["42P01", "PGRST205"].includes(String((error as any)?.code || ""))) return [];
    throw error;
  }
  return (data || []).map((row: any) => ({
    id: String(row.id),
    adminTelegramId: Number(row.admin_telegram_id),
    adminUsername: row.admin_username ? String(row.admin_username) : null,
    stateId: String(row.state_id),
    stateName: String(Array.isArray(row.states) ? row.states[0]?.name || "Государство" : row.states?.name || "Государство"),
    playerId: row.player_id ? String(row.player_id) : null,
    playerName: row.player_id ? String(Array.isArray(row.players) ? row.players[0]?.display_name || "Игрок" : row.players?.display_name || "Игрок") : null,
    actionType: row.action_type === "message" ? "message" : "reward",
    rewardType: row.reward_type ? String(row.reward_type) : null,
    amount: Number(row.amount || 0),
    parameters: row.parameters && typeof row.parameters === "object" ? row.parameters : {},
    reason: row.reason ? String(row.reason) : null,
    messageText: row.message_text ? String(row.message_text) : null,
    createdAt: String(row.created_at),
  }));
}

export async function grantAdminReward(input: {
  adminTelegramId: number;
  adminUsername?: string | null;
  stateId: string;
  playerId?: string | null;
  rewardType: AdminRewardType;
  amount?: number;
  parameters?: Record<string, unknown>;
  reason?: string | null;
}) {
  const meta = REWARD_META[input.rewardType];
  if (!meta) throw new Error("Неизвестный тип награды.");
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase
    .from("states")
    .select("id,name,telegram_chat_id,bot_present")
    .eq("id", input.stateId)
    .eq("is_freeport", false)
    .single();
  if (stateError || !state) throw new Error("Государство не найдено.");
  if (!state.bot_present || !state.telegram_chat_id) throw new Error("Бот сейчас недоступен в этом Telegram-чате.");
  let playerName: string | null = null;
  if (input.playerId) {
    const { data: player, error: playerError } = await supabase.from("players").select("display_name,username").eq("id", input.playerId).maybeSingle();
    if (playerError) throw playerError;
    if (!player) throw new Error("Игрок для награды не найден.");
    playerName = player.username ? `${String(player.display_name)} (@${String(player.username).replace(/^@/, "")})` : String(player.display_name || "Игрок");
  }

  const parameters = input.parameters && typeof input.parameters === "object" ? input.parameters : {};
  const reason = clampText(input.reason, 500) || null;
  const amount = Number.isFinite(Number(input.amount)) ? Math.trunc(Number(input.amount)) : 0;
  const { data: result, error } = await supabase.rpc("gw_admin_apply_reward", {
    p_admin_telegram_id: input.adminTelegramId,
    p_admin_username: safeAdminUsername(input.adminUsername),
    p_state_id: input.stateId,
    p_player_id: input.playerId || null,
    p_reward_type: input.rewardType,
    p_amount: amount,
    p_parameters: parameters,
    p_reason: reason,
  });
  if (error) {
    if (["PGRST202", "42883"].includes(String((error as any)?.code || ""))) throw new Error("Сначала примените миграцию 035_admin_rewards_medals_access.sql.");
    throw error;
  }

  const rawValue = String((result as any)?.label || meta.label);
  const value = rewardValue(input.rewardType, rawValue, amount, parameters, playerName);
  const text =
    `📢 Администрация WARSTATE\n\n` +
    `Государству ${String(state.name)} выдана награда:\n` +
    `🎁 ${meta.label} — ${value}` +
    `${reason ? `\nПричина: ${reason}` : ""}\n` +
    `Выдал: ${adminLabel(input.adminTelegramId, input.adminUsername)}.`;

  let notificationSent = true;
  try {
    await telegramApi("sendMessage", { chat_id: Number(state.telegram_chat_id), text, link_preview_options: { is_disabled: true } });
  } catch (notifyError) {
    notificationSent = false;
    console.warn("WARSTATE admin reward chat notification failed", notifyError);
  }
  return { ok: true, label: value, notificationSent };
}

export async function sendAdminStateMessage(input: {
  adminTelegramId: number;
  adminUsername?: string | null;
  stateId: string;
  text: string;
}) {
  const message = clampText(input.text, 3500);
  if (!message) throw new Error("Введите текст сообщения.");
  const supabase = getSupabaseAdmin();
  const { data: state, error } = await supabase.from("states").select("id,name,telegram_chat_id,bot_present").eq("id", input.stateId).eq("is_freeport", false).single();
  if (error || !state) throw new Error("Государство не найдено.");
  if (!state.bot_present || !state.telegram_chat_id) throw new Error("Бот сейчас недоступен в этом Telegram-чате.");
  const body = `📢 Администрация WARSTATE\n\n${message}\n\nОтправил: ${adminLabel(input.adminTelegramId, input.adminUsername)}.`;
  await telegramApi("sendMessage", { chat_id: Number(state.telegram_chat_id), text: body, link_preview_options: { is_disabled: true } });
  const { error: logError } = await supabase.from("admin_reward_log").insert({
    admin_telegram_id: input.adminTelegramId,
    admin_username: safeAdminUsername(input.adminUsername),
    state_id: input.stateId,
    action_type: "message",
    reward_type: null,
    amount: 0,
    parameters: {},
    message_text: message,
  });
  if (logError) {
    // The Telegram message has already been delivered. Do not report the whole
    // action as failed, otherwise the admin may retry and duplicate it in chat.
    console.error("WARSTATE admin free-message history write failed after delivery", logError);
    return { ok: true, historyRecorded: false };
  }
  return { ok: true, historyRecorded: true };
}

async function dmAdminGroupLink(adminTelegramId: number, stateName: string, url: string, isInvite: boolean) {
  await telegramApi("sendMessage", {
    chat_id: adminTelegramId,
    text: isInvite ? `🔗 Приглашение в группу «${stateName}»\n${url}` : `🔗 Ссылка на группу «${stateName}»\n${url}`,
    reply_markup: { inline_keyboard: [[{ text: "Открыть группу", url }]] },
    link_preview_options: { is_disabled: true },
  });
}

export async function resolveAdminGroupLink(
  stateId: string,
  options: { admin?: { telegramId: number }; notify?: boolean } = {},
) {
  const supabase = getSupabaseAdmin();
  const { data: state, error } = await supabase.from("states").select("id,name,telegram_chat_id,telegram_chat_username,bot_present").eq("id", stateId).eq("is_freeport", false).single();
  if (error || !state) throw new Error("Государство не найдено.");
  if (!state.bot_present || !state.telegram_chat_id) throw new Error("Бот удалён из этой группы.");
  let username = state.telegram_chat_username ? String(state.telegram_chat_username).replace(/^@/, "") : "";
  try {
    const chat = await getChat(Number(state.telegram_chat_id));
    username = chat.username ? String(chat.username).replace(/^@/, "") : "";
    const { error: cacheError } = await supabase.from("states").update({ telegram_chat_username: username || null, telegram_chat_title: chat.title || state.name }).eq("id", stateId);
    if (cacheError) console.warn("WARSTATE admin group cache update failed", cacheError);
  } catch (chatError) {
    console.warn("WARSTATE admin group link refresh failed", chatError);
  }

  const notify = options.notify !== false && Boolean(options.admin);

  if (username) {
    const url = `https://t.me/${username}`;
    if (notify) void dmAdminGroupLink(options.admin!.telegramId, String(state.name), url, false).catch((e) => console.warn("WARSTATE admin link DM failed", e));
    return { stateId, name: String(state.name), isPublic: true, url, pendingRequest: null, inviteRecovered: false };
  }

  // Private groups deliberately use the owner/admin Reply flow. The project bot
  // does not mint an invitation on the Administration's behalf.
  const { data: latestAccess, error: latestAccessError } = await supabase
    .from("admin_chat_access_requests")
    .select("id,status,requested_at,invite_link,fulfilled_at")
    .eq("state_id", stateId)
    .gt("request_message_id", 0)
    .in("status", ["pending", "fulfilled"])
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestAccessError) throw latestAccessError;
  const fulfilledInvite = latestAccess?.status === "fulfilled" && latestAccess?.invite_link ? String(latestAccess.invite_link) : null;
  if (fulfilledInvite && notify) void dmAdminGroupLink(options.admin!.telegramId, String(state.name), fulfilledInvite, true).catch((e) => console.warn("WARSTATE admin link DM failed", e));
  return {
    stateId,
    name: String(state.name),
    isPublic: false,
    url: fulfilledInvite,
    pendingRequest: latestAccess?.status === "pending" ? { id: String(latestAccess.id), requestedAt: String(latestAccess.requested_at) } : null,
    inviteRecovered: Boolean(fulfilledInvite),
  };
}

export async function requestAdminGroupAccess(input: { stateId: string; adminTelegramId: number; adminUsername?: string | null }) {
  const supabase = getSupabaseAdmin();
  const { data: state, error } = await supabase.from("states").select("id,name,telegram_chat_id,bot_present").eq("id", input.stateId).eq("is_freeport", false).single();
  if (error || !state) throw new Error("Государство не найдено.");
  if (!state.bot_present || !state.telegram_chat_id) throw new Error("Бот сейчас недоступен в этой группе.");

  const { error: cancelError } = await supabase.from("admin_chat_access_requests").update({ status: "cancelled" }).eq("state_id", input.stateId).eq("admin_telegram_id", input.adminTelegramId).eq("status", "pending");
  if (cancelError) throw cancelError;
  const sent = await telegramApi<{ message_id: number }>("sendMessage", {
    chat_id: Number(state.telegram_chat_id),
    text:
      `🔔 Запрос от Администрации WARSTATE\n\n` +
      `Администрация запрашивает приглашение в ваше государство.\n` +
      `Ответьте на это сообщение пригласительной ссылкой — бот перешлёт её админу.\n\n` +
      `Ответ принимается только от владельца или администратора группы.`,
    reply_markup: { force_reply: true, input_field_placeholder: "Вставьте пригласительную ссылку" },
    link_preview_options: { is_disabled: true },
  });
  const { data: request, error: requestError } = await supabase.from("admin_chat_access_requests").insert({
    state_id: input.stateId,
    admin_telegram_id: input.adminTelegramId,
    admin_username: safeAdminUsername(input.adminUsername),
    request_message_id: Number(sent.message_id),
    status: "pending",
  }).select("id,requested_at").single();
  if (requestError) {
    // Avoid leaving an orphan ForceReply message that can never be matched to
    // an access request if the DB write fails after Telegram accepted it.
    await telegramApi("deleteMessage", { chat_id: Number(state.telegram_chat_id), message_id: Number(sent.message_id) })
      .catch((cleanupError) => console.warn("WARSTATE orphan access request cleanup failed", cleanupError));
    throw requestError;
  }
  return { id: String(request.id), requestedAt: String(request.requested_at) };
}

function inviteFromMessage(message: any) {
  const isInvite = (value: string) => /^https?:\/\/(?:t\.me|telegram\.me)\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+)(?:[?#].*)?$/i.test(value.trim());
  const text = String(message?.text || message?.caption || "").trim();
  const match = text.match(/https?:\/\/(?:t\.me|telegram\.me)\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+)/i);
  if (match && isInvite(match[0])) return match[0];
  const entities = [...(Array.isArray(message?.entities) ? message.entities : []), ...(Array.isArray(message?.caption_entities) ? message.caption_entities : [])];
  for (const entity of entities) {
    if (entity?.type === "text_link" && typeof entity.url === "string" && isInvite(String(entity.url))) return String(entity.url).trim();
  }
  return null;
}

export async function handleAdminAccessReply(message: any): Promise<boolean> {
  const replyId = Number(message?.reply_to_message?.message_id || 0);
  const chatId = Number(message?.chat?.id || 0);
  const senderId = Number(message?.from?.id || 0);
  if (!replyId || !chatId || !senderId) return false;
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase.from("states").select("id,name").eq("telegram_chat_id", chatId).maybeSingle();
  if (stateError || !state) return false;
  const { data: request, error: requestError } = await supabase
    .from("admin_chat_access_requests")
    .select("id,admin_telegram_id")
    .eq("state_id", state.id)
    .eq("request_message_id", replyId)
    .eq("status", "pending")
    .maybeSingle();
  if (requestError || !request) return false;

  const member = await getChatMember(chatId, senderId).catch(() => null);
  if (!member || !["creator", "administrator"].includes(String(member.status))) {
    await telegramApi("sendMessage", { chat_id: chatId, reply_to_message_id: message.message_id, text: "Приглашение может отправить только владелец или администратор группы." }).catch(() => undefined);
    return true;
  }
  const inviteLink = inviteFromMessage(message);
  if (!inviteLink) {
    await telegramApi("sendMessage", { chat_id: chatId, reply_to_message_id: message.message_id, text: "Не вижу пригласительную ссылку. Ответьте ещё раз и вставьте ссылку вида https://t.me/+..." }).catch(() => undefined);
    return true;
  }

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase.from("admin_chat_access_requests").update({ status: "fulfilled", invite_link: inviteLink, fulfilled_at: now }).eq("id", request.id).eq("status", "pending").select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return true;
  await telegramApi("sendMessage", {
    chat_id: Number(request.admin_telegram_id),
    text: `Приглашение в группу ${String(state.name)}\n${inviteLink}`,
    reply_markup: { inline_keyboard: [[{ text: "Открыть группу", url: inviteLink }]] },
    link_preview_options: { is_disabled: true },
  }).catch((error) => console.warn("WARSTATE access invite DM failed", error));
  await telegramApi("sendMessage", { chat_id: chatId, reply_to_message_id: message.message_id, text: "Приглашение передано Администрации WARSTATE." }).catch(() => undefined);
  return true;
}
