import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { completeDailyActivity } from "@/lib/strategy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const activityKey = String(body.activityKey || "");
    const optionKey = String(body.optionKey || "");
    if (!stateId) throw new Error("stateId is required");
    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    const result = await completeDailyActivity(player.id, stateId, activityKey, optionKey);
    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, result });
  } catch (error) {
    return jsonError(error);
  }
}
