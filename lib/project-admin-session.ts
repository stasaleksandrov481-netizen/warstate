import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isProjectAdminTelegramId } from "@/lib/config";

export async function setProjectAdminChatMode(telegramId: number, chatId: number, enabled: boolean) {
  if (!isProjectAdminTelegramId(telegramId)) throw new Error("Этот Telegram ID не входит в список создателей проекта.");
  const supabase = getSupabaseAdmin();
  if (!enabled) {
    const { error } = await supabase.from("project_admin_chat_sessions").delete().eq("telegram_id", telegramId).eq("telegram_chat_id", chatId);
    if (error && error.code !== "42P01") throw error;
    return false;
  }
  const { error } = await supabase.from("project_admin_chat_sessions").upsert({
    telegram_id: telegramId,
    telegram_chat_id: chatId,
    enabled: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "telegram_id,telegram_chat_id" });
  if (error) {
    if (error.code === "42P01" || String(error.message || "").includes("project_admin_chat_sessions")) {
      throw new Error("Не применена миграция 026_global_project_admin_and_chat_join.sql.");
    }
    throw error;
  }
  return true;
}

export async function isProjectAdminChatMode(telegramId: number, chatId: number) {
  if (!isProjectAdminTelegramId(telegramId)) return false;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("project_admin_chat_sessions")
    .select("enabled")
    .eq("telegram_id", telegramId)
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) {
    if (error.code === "42P01" || String(error.message || "").includes("project_admin_chat_sessions")) return false;
    throw error;
  }
  return Boolean(data?.enabled);
}
