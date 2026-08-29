import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isProjectAdminTelegramId } from "@/lib/config";

export const BOT_CLOSED_CODE = "BOT_CLOSED" as const;

export interface BotStatus {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export class BotClosedError extends Error {
  readonly code = BOT_CLOSED_CODE;
  readonly reason: string | null;

  constructor(reason: string | null) {
    super("WARSTATE временно закрыт для использования.");
    this.name = "BotClosedError";
    this.reason = reason;
  }
}

export async function getBotStatus(): Promise<BotStatus> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bot_runtime_settings")
    .select("enabled,reason,updated_at")
    .eq("id", 1)
    .maybeSingle();

  // During a rolling deployment the migration can be applied a little later
  // than the application. Fail open rather than taking the whole bot down.
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      return { enabled: true, reason: null, updatedAt: null };
    }
    throw error;
  }

  if (!data) return { enabled: true, reason: null, updatedAt: null };
  return {
    enabled: data.enabled !== false,
    reason: data.reason ? String(data.reason) : null,
    updatedAt: data.updated_at ? String(data.updated_at) : null,
  };
}

export async function assertBotOpenForUser(telegramId: number) {
  if (isProjectAdminTelegramId(telegramId)) return;
  const status = await getBotStatus();
  if (!status.enabled) throw new BotClosedError(status.reason);
  return status;
}

export async function setBotStatus(input: {
  enabled: boolean;
  reason?: string | null;
  adminTelegramId: number;
}) {
  if (!isProjectAdminTelegramId(input.adminTelegramId)) {
    throw new Error("Нет прав доступа к управлению режимом бота.");
  }
  const reason = input.enabled ? null : (String(input.reason || "").trim().slice(0, 500) || null);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bot_runtime_settings")
    .upsert({
      id: 1,
      enabled: input.enabled,
      reason,
      updated_by: input.adminTelegramId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" })
    .select("enabled,reason,updated_at")
    .single();
  if (error) throw error;
  return {
    enabled: data.enabled !== false,
    reason: data.reason ? String(data.reason) : null,
    updatedAt: data.updated_at ? String(data.updated_at) : null,
  } satisfies BotStatus;
}

export function botClosedText(reason: string | null) {
  const body = reason
    ? `Причина: ${reason}\n\nЕсли вам нужна дополнительная информация, обратитесь к администрации WARSTATE.`
    : `Работы уже ведутся, а доступ вернётся автоматически после открытия.\n\nЕсли нужна дополнительная информация, обратитесь к администрации WARSTATE.`;
  return `⏸ WARSTATE ВРЕМЕННО ЗАКРЫТ\n────────────\nСейчас бот временно приостановил работу и не принимает игровые команды.\n\n${body}`;
}

export function botClosedMiniAppText(reason: string | null) {
  return reason
    ? `WARSTATE временно закрыт.\n\nПричина: ${reason}\n\nОбратитесь к администрации WARSTATE, если нужна дополнительная информация.`
    : `WARSTATE временно закрыт.\n\nИгровой доступ приостановлен до открытия бота. Обратитесь к администрации WARSTATE, если нужна дополнительная информация.`;
}
