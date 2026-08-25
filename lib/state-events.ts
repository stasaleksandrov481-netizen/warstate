import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";

/**
 * Единая шина игровых событий. Любое важное изменение государства
 * должно проходить через неё, чтобы Telegram и Mini App не расходились.
 */
export async function publishStateEvent(stateId: string, title: string, body: string) {
  const supabase = getSupabaseAdmin();
  const { data: state } = await supabase
    .from("states")
    .select("telegram_chat_id,name")
    .eq("id", stateId)
    .maybeSingle();

  if (!state?.telegram_chat_id) return;

  const text = `${title}\n────────────\n${body}`;
  await telegramApi("sendMessage", {
    chat_id: state.telegram_chat_id,
    text,
    link_preview_options: { is_disabled: true },
  }).catch(() => null);
}

export async function publishStateAudit(stateId: string, action: string, details: string) {
  const supabase = getSupabaseAdmin();
  try {
    await supabase.from("state_events").insert({
      state_id: stateId,
      event_type: action,
      message: details,
    });
  } catch (error) {
    console.warn("WARSTATE state audit event skipped", error);
  }
}
