import { getGameSnapshot, tickState } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { reconcileStateRuntime } from "@/lib/maintenance";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const stateId = new URL(request.url).searchParams.get("stateId");
    if (!stateId) throw new Error("stateId is required");
    const { player, member, session, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!state.is_freeport) {
      await reconcileStateRuntime(stateId);
      await tickState(stateId);
    }
    return Response.json(await getGameSnapshot(player.id, stateId, session.user.id, member.role));
  } catch (error) {
    return jsonError(error);
  }
}
