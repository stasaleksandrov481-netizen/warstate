export function requireServerEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function parseTelegramIdList(raw: string | undefined) {
  return new Set(
    String(raw || "")
      .split(/[\s,;]+/)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

export function projectAdminTelegramIds() {
  const combined = [
    process.env.WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS,
    process.env.WARSTATE_SUPERADMIN_TELEGRAM_ID,
  ].filter(Boolean).join(",");
  return parseTelegramIdList(combined);
}

export function isProjectAdminTelegramId(telegramId: number | string | null | undefined) {
  const value = Number(telegramId);
  return Number.isSafeInteger(value) && value > 0 && projectAdminTelegramIds().has(value);
}

export function requireTelegramBotUsername() {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username) || !username.toLowerCase().endsWith("bot")) {
    throw new Error("Telegram-бот не активирован: задайте корректный username бота, оканчивающийся на bot.");
  }
  return username;
}
