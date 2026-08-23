import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface TelegramSession {
  user: TelegramUser;
  authDate: number;
  startParam?: string | null;
}

export function validateTelegramInitData(initData: string, botToken: string, maxAgeSeconds = 3600): TelegramSession {
  if (!initData) throw new Error("Missing Telegram initData");

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram initData has no hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(calculatedHash, "hex");
  const b = Buffer.from(receivedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > maxAgeSeconds) throw new Error("Telegram initData expired");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("Telegram user missing");
  const user = JSON.parse(userRaw) as TelegramUser;

  return {
    user,
    authDate,
    startParam: params.get("start_param"),
  };
}

export function parseGroupStartParam(startParam?: string | null) {
  if (!startParam) return null;
  const match = /^gw_(-?\d+)$/.exec(startParam);
  if (!match) return null;
  return Number(match[1]);
}
