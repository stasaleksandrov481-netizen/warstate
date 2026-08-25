import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { castVote, finalizeElection, nominateCandidate } from "@/lib/politics";
import { notifyStateChat, openGovernmentElection } from "@/lib/government";
import { getGameSnapshot } from "@/lib/game";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { reconcileStateRuntime } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const action = String(body.action || "");
    if (!stateId) throw new Error("stateId is required");
    const auth = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (auth.state.is_freeport) throw new Error("В Freeport нет президента и выборов.");

    if (body.electionId) {
      const supabase = getSupabaseAdmin();
      const { data: election, error: electionError } = await supabase
        .from("state_elections")
        .select("state_id")
        .eq("id", String(body.electionId))
        .maybeSingle();
      if (electionError) throw electionError;
      if (!election || election.state_id !== stateId) throw new Error("Эти выборы относятся к другому государству.");
    }

    if (action === "open") {
      if (String(auth.state.founder_player_id || "") !== String(auth.player.id)) throw new Error("Внеочередные выборы запускает только Основатель.");
      // Reconcile first so a previous, already-expired election is finalized
      // instead of colliding with the new one (only one 'open' election per
      // state is allowed at the database level).
      await reconcileStateRuntime(stateId, { force: true });
      await openGovernmentElection(stateId, auth.player.id);
      await notifyStateChat(stateId, "🗳 Начались выборы президента! Откройте WARSTATE и выберите кандидата.");
    } else if (action === "nominate") {
      if (!body.electionId) throw new Error("electionId is required");
      await nominateCandidate(String(body.electionId), auth.player.id, String(body.statement || ""));
    } else if (action === "vote") {
      if (!body.electionId || !body.candidateId) throw new Error("Выберите кандидата.");
      await castVote(String(body.electionId), auth.player.id, String(body.candidateId));
    } else if (action === "finalize") {
      if (!body.electionId) throw new Error("electionId is required");
      const result = await finalizeElection(String(body.electionId));
      if ((result as { applied?: boolean } | null)?.applied) {
        await notifyStateChat(stateId, "🗳 Выборы завершены. Итог подведён из Mini App.");
      }
    } else {
      throw new Error("Неизвестное действие.");
    }

    const supabase = getSupabaseAdmin();
    const { data: latestMember, error: latestMemberError } = await supabase.from("state_members").select("role").eq("state_id", stateId).eq("player_id", auth.player.id).maybeSingle();
    if (latestMemberError) throw latestMemberError;
    return Response.json(await getGameSnapshot(auth.player.id, stateId, auth.session.user.id, latestMember?.role || auth.member.role));
  } catch (error) {
    return jsonError(error);
  }
}
