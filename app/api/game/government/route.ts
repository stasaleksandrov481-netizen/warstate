import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { bootstrapGame, getGameSnapshot } from "@/lib/game";
import {
  appointPresidentByPlayerId,
  deleteState,
  notifyStateChat,
  openGovernmentElection,
  removePresident,
  renameState,
  requestFounderSelfPresidency,
  resolveStateMemberByUsername,
  setDeputy,
  setStateUsername,
  voteForUsername,
} from "@/lib/government";
import { createStateVote } from "@/lib/community";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { reconcileStateRuntime } from "@/lib/maintenance";
import { assertTelegramChatOwner } from "@/lib/telegram-bot";
import { isProjectAdminTelegramId } from "@/lib/config";

export const runtime = "nodejs";

function actorLabel(player: { display_name?: string | null; username?: string | null }) {
  return `${player.display_name || "Игрок"}${player.username ? ` (@${player.username})` : ""}`;
}

function targetLabel(target: { display_name?: string | null; username?: string | null }) {
  return `${target.display_name || "Игрок"}${target.username ? ` (@${target.username})` : ""}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const action = String(body.action || "");
    if (!stateId || !action) throw new Error("stateId and action are required");
    const auth = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (auth.state.is_freeport) throw new Error("У нейтральной зоны нет собственного правительства.");
    await reconcileStateRuntime(stateId, { force: true });

    const actor = actorLabel(auth.player);
    // Every branch fills this in with the message shown in the state's
    // Telegram group so Mini App actions are as visible as chat commands.
    let notification: string | null = null;

    if (action === "open_election") {
      await openGovernmentElection(stateId, auth.player.id);
      notification = `🗳 ВЫБОРЫ ПРЕЗИДЕНТА\n\n${actor} открыл(а) внеочередные выборы в Mini App. Голосование открыто на 15 минут — !голосовать @игрок.`;
    } else if (action === "vote_username") {
      const { target } = await voteForUsername(stateId, auth.player.id, String(body.username || ""));
      notification = `🗳 ${actor} проголосовал(а) за ${targetLabel(target)} в Mini App.`;
    } else if (action === "appoint_president") {
      const target = await resolveStateMemberByUsername(stateId, String(body.username || ""));
      const isSelf = String(target.id) === String(auth.player.id);
      const { data: founderState, error: founderStateError } = await getSupabaseAdmin()
        .from("states")
        .select("founder_player_id")
        .eq("id", stateId)
        .single();
      if (founderStateError) throw founderStateError;
      const isFounder = String(founderState?.founder_player_id || "") === String(auth.player.id);
      if (isSelf && isFounder && !isProjectAdminTelegramId(auth.session.user.id)) {
        await requestFounderSelfPresidency(stateId, auth.player.id);
        notification = `🗳 ${actor} выдвинул(а) себя в президенты. Решение принимают граждане на 15-минутном голосовании: нужен хотя бы один голос другого гражданина и большинство среди поданных голосов.`;
      } else {
        const appointed = await appointPresidentByPlayerId(stateId, auth.player.id, String(target.id));
        notification = `👑 ${actor} назначил(а) ${targetLabel(appointed)} президентом через Mini App.`;
      }
    } else if (action === "request_self_presidency") {
      await requestFounderSelfPresidency(stateId, auth.player.id);
      notification = `🗳 ${actor} выдвинул(а) себя в президенты. Решение принимают граждане на 15-минутном голосовании: нужен хотя бы один голос другого гражданина и большинства среди поданных голосов. Граждане могут голосовать в Mini App или командой !голосовать.`;
    } else if (action === "admin_self_president") {
      throw new Error("Админ бота не становится президентом. Используйте права администратора бота или обычное назначение президента.");
      const { data: founderState, error: founderStateError } = await getSupabaseAdmin()
        .from("states")
        .select("founder_player_id")
        .eq("id", stateId)
        .single();
      if (founderStateError) throw founderStateError;
      if (String(founderState?.founder_player_id || "") !== String(auth.player.id)) throw new Error("Админ-назначение себя президентом доступно только в вашем собственном государстве.");
      const target = await appointPresidentByPlayerId(stateId, auth.player.id, auth.player.id);
      notification = `🧪 ${actor} включил(а) тестовый режим создателя проекта и назначил(а) себя президентом без голосования.`;
    } else if (action === "remove_president") {
      await removePresident(stateId, auth.player.id);
      notification = `👑 ${actor} снял(а) президента с должности через Mini App. Государство временно без президента.`;
    } else if (action === "appoint_deputy") {
      const target = await setDeputy(stateId, auth.player.id, String(body.username || ""), true);
      notification = `🛡 ${actor} назначил(а) ${targetLabel(target)} заместителем через Mini App.`;
    } else if (action === "remove_deputy") {
      const target = await setDeputy(stateId, auth.player.id, String(body.username || ""), false);
      notification = `🛡 ${actor} снял(а) ${targetLabel(target)} с поста заместителя через Mini App.`;
    } else if (action === "set_username") {
      const data = await setStateUsername(stateId, auth.player.id, String(body.username || ""));
      const username = (data as { username?: string } | null)?.username;
      notification = `🌐 ${actor} задал(а) игровой юз государства${username ? `: @${username}` : ""}.`;
    } else if (action === "rename_state") {
      const data = await renameState(stateId, auth.player.id, String(body.name || ""));
      const name = (data as { name?: string } | null)?.name;
      notification = `🏛 ${actor} переименовал(а) государство${name ? ` в «${name}»` : ""}.`;
    } else if (action === "delete_state") {
      if (!auth.state.telegram_chat_id) throw new Error("У государства не привязан Telegram-чат.");
      await assertTelegramChatOwner(Number(auth.state.telegram_chat_id), auth.session.user.id);
      await notifyStateChat(stateId, `⚠️ ${actor} удалил(а) государство через Mini App.`);
      await deleteState(stateId, auth.player.id);
      return Response.json(await bootstrapGame(auth.session.user, null));
    } else if (action === "start_impeachment") {
      if (!auth.state.owner_player_id) throw new Error("Президента нет — импичмент невозможен.");
      const presidentPlayerId = String(auth.state.owner_player_id);
      const { data: president, error: presidentError } = await getSupabaseAdmin().from("players").select("display_name,username").eq("id", presidentPlayerId).maybeSingle();
      if (presidentError) throw presidentError;
      const presidentName = president?.display_name || "президент";
      await createStateVote({
        stateId,
        createdByPlayerId: auth.player.id,
        kind: "impeachment",
        targetStateId: stateId,
        payload: { presidentPlayerId },
        durationMinutes: 5,
      });
      notification = `⚖ ИМПИЧМЕНТ\n\n${actor} инициировал(а) голосование об отстранении ${presidentName} от должности президента. Голосование открыто на 5 минут. Голосуйте: !голосование`;
    } else {
      throw new Error("Неизвестное действие правительства.");
    }

    if (notification) await notifyStateChat(stateId, notification);

    const supabase = getSupabaseAdmin();
    const { data: latestMember, error } = await supabase.from("state_members").select("role").eq("state_id", stateId).eq("player_id", auth.player.id).single();
    if (error) throw error;
    return Response.json(await getGameSnapshot(auth.player.id, stateId, auth.session.user.id, latestMember?.role || auth.member.role));
  } catch (error) {
    return jsonError(error);
  }
}
