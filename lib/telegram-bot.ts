import { tryCommandCooldown } from "@/lib/cooldown";

const API = "https://api.telegram.org";

export async function telegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let json: { ok?: boolean; description?: string; result?: T };
  try {
    json = JSON.parse(raw) as { ok?: boolean; description?: string; result?: T };
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON (${response.status})`);
  }
  if (!response.ok || !json.ok) throw new Error(`Telegram ${method} failed: ${json.description || `HTTP ${response.status}`}`);
  return json.result as T;
}

export function miniAppLink(chatId?: number | string | null, stateId?: string | null) {
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const shortName = process.env.TELEGRAM_MINI_APP_SHORT_NAME;
  const start = stateId ? `state_${stateId}` : (chatId === undefined || chatId === null ? null : `gw_${chatId}`);
  if (!username || !shortName) {
    throw new Error("TELEGRAM_BOT_USERNAME and TELEGRAM_MINI_APP_SHORT_NAME must be configured for the live Mini App.");
  }
  return start
    ? `https://t.me/${username}/${shortName}?startapp=${encodeURIComponent(start)}`
    : `https://t.me/${username}/${shortName}`;
}

// Dedicated deep link into the Mini App admin panel (see components/game/admin-panel.tsx).
// Kept separate from miniAppLink() because "admin" is not a state/group start token.
export function adminMiniAppLink() {
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const shortName = process.env.TELEGRAM_MINI_APP_SHORT_NAME;
  if (!username || !shortName) {
    throw new Error("TELEGRAM_BOT_USERNAME and TELEGRAM_MINI_APP_SHORT_NAME must be configured for the live Mini App.");
  }
  return `https://t.me/${username}/${shortName}?startapp=admin`;
}

export type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export async function getChatMember(chatId: number, userId: number) {
  return telegramApi<{ status: ChatMemberStatus; is_member?: boolean }>("getChatMember", { chat_id: chatId, user_id: userId });
}

export async function getChat(chatId: number) {
  return telegramApi<{
    id: number;
    title?: string;
    username?: string;
    invite_link?: string;
    photo?: { small_file_id?: string; big_file_id?: string };
  }>("getChat", { chat_id: chatId });
}

export function isTelegramChatMember(member: { status: ChatMemberStatus; is_member?: boolean }) {
  if (["creator", "administrator", "member"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member !== false;
}

export async function assertTelegramChatOwner(chatId: number, userId: number) {
  const member = await getChatMember(chatId, userId);
  if (member.status !== "creator") {
    throw new Error("Удалить государство может только владелец Telegram-чата.");
  }
  return member;
}

export class TelegramMembershipRequiredError extends Error {
  inviteLink: string | null;

  constructor(message: string, inviteLink: string | null) {
    super(message);
    this.name = "TelegramMembershipRequiredError";
    this.inviteLink = inviteLink;
  }
}

export async function createStateJoinLink(chatId: number, name: string) {
  try {
    return (await createSingleUseInviteLink(chatId, name)).invite_link;
  } catch {
    try {
      const chat = await getChat(chatId);
      if (chat.invite_link) return chat.invite_link;
      if (chat.username) return `https://t.me/${chat.username.replace(/^@/, "")}`;
    } catch {
      // The membership gate still denies admission even if Telegram cannot mint a link.
    }
    return null;
  }
}

export async function assertTelegramChatMembership(
  chatId: number,
  userId: number,
  playerName = "Игрок",
  options: { sendInvite?: boolean } = {},
) {
  const member = await getChatMember(chatId, userId);
  if (isTelegramChatMember(member)) return member;

  // The Mini App itself uses the returned inviteLink to redirect the user (see game-app.tsx), so we
  // always resolve it — but repeated taps on "Перейти" shouldn't re-send a fresh DM every time. Guard
  // only the DM: if we already DM'd this same invite attempt in the last 20s, skip sending another.
  const inviteLink = await createStateJoinLink(chatId, `WARSTATE · ${playerName}`);
  const allowSend = options.sendInvite !== false && (await tryCommandCooldown(chatId, userId, "join_invite_dm", 20));
  let inviteSent = false;
  if (allowSend && inviteLink) {
    inviteSent = await telegramApi("sendMessage", {
      chat_id: userId,
      text: "🏛 ВСТУПЛЕНИЕ В ГОСУДАРСТВО\n────────────\nСначала вступите в Telegram-чат этого государства. Затем вернитесь на карту WARSTATE и нажмите «Перейти» ещё раз.",
      reply_markup: { inline_keyboard: [[{ text: "Вступить в чат Государства", url: inviteLink }]] },
    }).then(() => true).catch(() => false);
  }
  throw new TelegramMembershipRequiredError(
    inviteLink
      ? inviteSent
        ? "Сначала вступите в Telegram-чат этого Государства. Пригласительная ссылка отправлена вам в личные сообщения."
        : "Сначала вступите в Telegram-чат этого Государства. Откройте личный чат с ботом (/start), чтобы бот смог отправить приглашение."
      : "Сначала вступите в Telegram-чат этого Государства. Боту не удалось создать пригласительную ссылку: проверьте права администратора.",
    inviteLink,
  );
}

export async function getChatMemberCount(chatId: number) {
  return telegramApi<number>("getChatMemberCount", { chat_id: chatId });
}

export async function getTelegramFile(fileId: string) {
  return telegramApi<{ file_id: string; file_unique_id: string; file_path?: string }>("getFile", { file_id: fileId });
}

export function telegramFileUrl(filePath: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return `${API}/file/bot${token}/${filePath}`;
}

export async function createSingleUseInviteLink(chatId: number, name: string) {
  const expireDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  return telegramApi<{ invite_link: string }>("createChatInviteLink", {
    chat_id: chatId,
    name: name.slice(0, 32),
    expire_date: expireDate,
    member_limit: 1,
  });
}

export async function getChatAdministrators(chatId: number) {
  return telegramApi<Array<{
    status: ChatMemberStatus;
    user: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
  }>>("getChatAdministrators", { chat_id: chatId });
}
