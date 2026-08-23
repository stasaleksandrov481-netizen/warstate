const API = "https://api.telegram.org";

export async function telegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description || "unknown error"}`);
  return json.result as T;
}

export function miniAppLink(chatId: number | string) {
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const shortName = process.env.TELEGRAM_MINI_APP_SHORT_NAME;
  const start = `gw_${chatId}`;
  if (username && shortName) return `https://t.me/${username}/${shortName}?startapp=${encodeURIComponent(start)}`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${appUrl}?startapp=${encodeURIComponent(start)}`;
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
