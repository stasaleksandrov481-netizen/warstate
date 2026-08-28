import { getGameSnapshot } from "@/lib/game";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertTelegramChatMembership } from "@/lib/telegram-bot";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const targetStateId = String(body.targetStateId || "");
    if (!targetStateId) throw new Error("Не выбрано государство.");

    const session = sessionFromRequest(request);
    const supabase = getSupabaseAdmin();
    const [{ data: player, error: playerError }, { data: target, error: targetError }] = await Promise.all([
      supabase.from("players").select("id,home_state_id").eq("telegram_id", session.user.id).single(),
      supabase.from("states").select("id,name,telegram_chat_id,is_freeport,is_beginner_island,founder_player_id").eq("id", targetStateId).single(),
    ]);
    if (playerError || !player) throw new Error("Игрок не найден. Сначала откройте WARSTATE в Telegram.");
    if (targetError || !target) throw new Error("Государство не найдено.");
    if (target.is_freeport) throw new Error("Нейтральная зона не требует вступления.");
    if (!target.telegram_chat_id) throw new Error("У государства не привязан Telegram-чат.");

    if (String(player.home_state_id || "") === String(target.id)) {
      const { data: currentMember, error: currentMemberError } = await supabase
        .from("state_members")
        .select("role")
        .eq("state_id", target.id)
        .eq("player_id", player.id)
        .single();
      if (currentMemberError) throw currentMemberError;
      return Response.json(await getGameSnapshot(player.id, target.id, session.user.id, currentMember?.role || "citizen"));
    }

    await assertTelegramChatMembership(
      Number(target.telegram_chat_id),
      session.user.id,
      session.user.first_name || "Игрок",
    );

    const verifiedAt = new Date().toISOString();
    const { error: switchError } = await supabase.rpc("gw_switch_player_state", {
      p_player_id: player.id,
      p_target_state_id: target.id,
      p_membership_verified_at: verifiedAt,
    });
    if (switchError) {
      if (switchError.code === "PGRST202") throw new Error("Не применена миграция 018_state_switch_delete_ui.sql.");
      throw new Error(switchError.message || "Не удалось сменить государство.");
    }

    const { data: member, error: memberError } = await supabase
      .from("state_members")
      .select("role")
      .eq("state_id", target.id)
      .eq("player_id", player.id)
      .single();
    if (memberError) throw memberError;

    return Response.json(await getGameSnapshot(player.id, target.id, session.user.id, member?.role || "citizen"));
  } catch (error) {
    return jsonError(error);
  }
}
