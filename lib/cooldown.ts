import { getSupabaseAdmin } from "@/lib/supabase/server";

// Shared spam guard: returns true if this (chat, user, command) may proceed right now, false if it fired
// too recently. Used to stop rapid repeats of !вступить, repeated taps on Mini App buttons, and repeated
// invite-link DMs from flooding a chat. Kept dependency-free (no lib/game.ts or lib/telegram-bot.ts
// imports) so both of those can use it without creating an import cycle.
export async function tryCommandCooldown(chatId: number, telegramId: number, command: string, windowSeconds = 10): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_try_command_cooldown", {
    p_chat_id: chatId,
    p_telegram_id: telegramId,
    p_command: command,
    p_window_seconds: windowSeconds,
  });
  if (error) { console.warn("WARSTATE command cooldown check failed, allowing through", error); return true; }
  return Boolean(data);
}
