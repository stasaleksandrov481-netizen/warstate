import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { recruitmentAction } from "@/lib/recruitment";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    if (!stateId) throw new Error("stateId is required");
    const auth = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    await recruitmentAction({
      playerId: auth.player.id,
      currentStateId: stateId,
      currentStateIsFreeport: Boolean(auth.state.is_freeport),
      role: auth.member.role,
      action: String(body.action || ""),
      targetStateId: body.targetStateId ? String(body.targetStateId) : undefined,
      targetPlayerId: body.targetPlayerId ? String(body.targetPlayerId) : undefined,
      requestId: body.requestId ? String(body.requestId) : undefined,
      message: body.message,
      headline: body.headline,
      minLevel: body.minLevel,
    });
    return Response.json(await getGameSnapshot(auth.player.id, stateId, auth.session.user.id, auth.member.role));
  } catch (error) {
    return jsonError(error);
  }
}
