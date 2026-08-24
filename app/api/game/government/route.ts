import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getGameSnapshot } from "@/lib/game";
import { appointPresident, openGovernmentElection, removePresident, renameState, setDeputy, setStateUsername, voteForUsername } from "@/lib/government";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { reconcileStateRuntime } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const action = String(body.action || "");
    if (!stateId || !action) throw new Error("stateId and action are required");
    const auth = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (auth.state.is_freeport) throw new Error("У Freeport нет собственного правительства.");
    await reconcileStateRuntime(stateId, { force: true });

    if (action === "open_election") {
      await openGovernmentElection(stateId, auth.player.id);
    } else if (action === "vote_username") {
      await voteForUsername(stateId, auth.player.id, String(body.username || ""));
    } else if (action === "appoint_president") {
      await appointPresident(stateId, auth.player.id, String(body.username || ""));
    } else if (action === "remove_president") {
      await removePresident(stateId, auth.player.id);
    } else if (action === "appoint_deputy") {
      await setDeputy(stateId, auth.player.id, String(body.username || ""), true);
    } else if (action === "remove_deputy") {
      await setDeputy(stateId, auth.player.id, String(body.username || ""), false);
    } else if (action === "set_username") {
      await setStateUsername(stateId, auth.player.id, String(body.username || ""));
    } else if (action === "rename_state") {
      await renameState(stateId, auth.player.id, String(body.name || ""));
    } else {
      throw new Error("Неизвестное действие правительства.");
    }

    const supabase = getSupabaseAdmin();
    const { data: latestMember, error } = await supabase.from("state_members").select("role").eq("state_id", stateId).eq("player_id", auth.player.id).single();
    if (error) throw error;
    return Response.json(await getGameSnapshot(auth.player.id, stateId, auth.session.user.id, latestMember?.role || auth.member.role));
  } catch (error) {
    return jsonError(error);
  }
}
