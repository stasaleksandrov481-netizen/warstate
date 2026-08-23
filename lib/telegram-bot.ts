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

export function miniAppLink(chatId?: number | string | null) {
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const shortName = process.env.TELEGRAM_MINI_APP_SHORT_NAME;
  const start = chatId === undefined || chatId === null ? null : `gw_${chatId}`;
  if (!username || !shortName) {
    throw new Error("TELEGRAM_BOT_USERNAME and TELEGRAM_MINI_APP_SHORT_NAME must be configured for the live Mini App.");
  }
  return start
    ? `https://t.me/${username}/${shortName}?startapp=${encodeURIComponent(start)}`
    : `https://t.me/${username}/${shortName}`;
}

export type ChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export async function getChatMember(chatId: number, userId: number) {
  return telegramApi<{ status: ChatMemberStatus }>("getChatMember", { chat_id: chatId, user_id: userId });
}

export async function getChat(chatId: number) {
  return telegramApi<{
    id: number;
    title?: string;
    username?: string;
    photo?: { small_file_id?: string; big_file_id?: string };
  }>("getChat", { chat_id: chatId });
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
