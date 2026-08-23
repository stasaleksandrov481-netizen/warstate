import { getSupabaseAdmin } from "@/lib/supabase/server";
import { validateTelegramInitData } from "@/lib/telegram";
import { getChatMember } from "@/lib/telegram-bot";
import { requireData } from "@/lib/invariants";

export function sessionFromRequest(request: Request) {
  const initData = request.headers.get("x-telegram-init-data") || "";
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram-бот не настроен на сервере.");
  if (!initData) throw new Error("Откройте игру внутри Telegram. В браузере live-версия не запускается.");
  return validateTelegramInitData(initData, token);
}

export async function authorizeStateAction(
  request: Request,
  stateId: string,
  options: { verifyTelegramMembership?: boolean; membershipMaxAgeMs?: number } = {},
) {
  const session = sessionFromRequest(request);
  const supabase = getSupabaseAdmin();
  const { data: player, error: playerError } = await supabase.from("players").select("*").eq("telegram_id", session.user.id).single();
  if (playerError) throw new Error("Игрок не найден. Откройте WARSTATE из Telegram-группы.");
  const playerRow = requireData(player, "Игрок не найден. Откройте WARSTATE из Telegram-группы.");
  const [{ data: member, error: memberError }, { data: state, error: stateError }] = await Promise.all([
    supabase.from("state_members").select("*").eq("state_id", stateId).eq("player_id", playerRow.id).single(),
    supabase.from("states").select("telegram_chat_id,is_freeport,is_beginner_island,game_level,max_level").eq("id", stateId).single(),
  ]);
  if (memberError) throw new Error("Вы не состоите в этом государстве.");
  if (stateError) throw new Error("Государство не найдено.");
  const memberRow = requireData(member, "Вы не состоите в этом государстве.");
  const stateRow = requireData(state, "Государство не найдено.");
  if (options.verifyTelegramMembership && !stateRow.is_freeport) {
    if (!stateRow.telegram_chat_id) throw new Error("У государства отсутствует Telegram-привязка.");
    const maxAgeMs = Math.max(15_000, options.membershipMaxAgeMs ?? 5 * 60_000);
    const verifiedAt = memberRow.membership_verified_at ? new Date(memberRow.membership_verified_at).getTime() : 0;
    if (!verifiedAt || !Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxAgeMs) {
      const telegramMember = await getChatMember(Number(stateRow.telegram_chat_id), session.user.id);
      if (["left", "kicked"].includes(telegramMember.status)) throw new Error("Вы больше не состоите в Telegram-группе этого государства.");
      const nextVerifiedAt = new Date().toISOString();
      const { error: verifyError } = await supabase
        .from("state_members")
        .update({ membership_verified_at: nextVerifiedAt })
        .eq("id", memberRow.id);
      if (verifyError) throw verifyError;
      memberRow.membership_verified_at = nextVerifiedAt;
    }
  }
  return { session, player: playerRow, member: memberRow, state: stateRow };
}

export function jsonError(error: unknown, status?: number) {
  const message = error instanceof Error ? error.message : "Не удалось выполнить действие.";
  const lower = message.toLocaleLowerCase("ru-RU");
  const inferred = status ?? (
    lower.includes("подп") || lower.includes("initdata") || lower.includes("в браузере live-версия") || lower.includes("внутри telegram") || lower.includes("истёк") || lower.includes("expired") ? 401 :
    lower.includes("нет прав") || lower.includes("только президент") || lower.includes("не состоите") || lower.includes("больше не состоите") || lower.includes("другому игроку") ? 403 :
    lower.includes("не найден") || lower.includes("не найдена") ? 404 :
    lower.includes("не настроен") || lower.includes("not configured") || lower.includes("unavailable") ? 503 : 400
  );
  return Response.json({ error: message }, { status: inferred });
}

export async function authorizeBattleAction(request: Request, battleId: string) {
  const session = sessionFromRequest(request);
  const supabase = getSupabaseAdmin();
  const { data: player, error: playerError } = await supabase.from("players").select("*").eq("telegram_id", session.user.id).single();
  if (playerError) throw new Error("Игрок не найден. Откройте WARSTATE из своей Telegram-группы.");
  const playerRow = requireData(player, "Игрок не найден. Откройте WARSTATE из своей Telegram-группы.");
  const { data: battle, error: battleError } = await supabase.from("battles").select("attacker_state_id,defender_state_id").eq("id", battleId).single();
  if (battleError) throw new Error("Битва не найдена.");
  const battleRow = requireData(battle, "Битва не найдена.");
  const stateIds = [battleRow.attacker_state_id, battleRow.defender_state_id].filter(Boolean);
  const { data: member, error: memberError } = await supabase.from("state_members").select("*").eq("player_id", playerRow.id).in("state_id", stateIds).limit(1).single();
  if (memberError) throw new Error("Ваше государство не участвует в этой битве.");
  const memberRow = requireData(member, "Ваше государство не участвует в этой битве.");

  const { data: state, error: stateError } = await supabase.from("states").select("telegram_chat_id,is_freeport,is_beginner_island,game_level,max_level").eq("id", memberRow.state_id).single();
  if (stateError) throw new Error("Государство не найдено.");
  const stateRow = requireData(state, "Государство не найдено.");

  // Battle actions are high-frequency. Re-check Telegram membership at most once per minute
  // instead of making a Bot API roundtrip for every shot/move/realtime refresh.
  const verifiedAt = memberRow.membership_verified_at ? new Date(memberRow.membership_verified_at).getTime() : 0;
  if (!stateRow.is_freeport && (!verifiedAt || Date.now() - verifiedAt > 60_000)) {
    if (!stateRow.telegram_chat_id) throw new Error("У государства отсутствует Telegram-привязка.");
    const telegramMember = await getChatMember(Number(stateRow.telegram_chat_id), session.user.id);
    if (["left", "kicked"].includes(telegramMember.status)) throw new Error("Вы больше не состоите в Telegram-группе этого государства.");
    const nextVerifiedAt = new Date().toISOString();
    const { error: verifyError } = await supabase.from("state_members").update({ membership_verified_at: nextVerifiedAt }).eq("id", memberRow.id);
    if (verifyError) throw verifyError;
    memberRow.membership_verified_at = nextVerifiedAt;
  }

  return { session, player: playerRow, member: memberRow, battle: battleRow, state: stateRow };
}
