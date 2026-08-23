import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { surrenderBattle } from "@/lib/strategy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const battleId = String(body.battleId || "");
    if (!stateId || !battleId) throw new Error("stateId and battleId are required");
    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!["president", "minister", "deputy"].includes(member.role)) throw new Error("Сдаться может только президент или заместитель.");
    await surrenderBattle(battleId, stateId);
    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json(snapshot);
  } catch (error) {
    return jsonError(error);
  }
}
