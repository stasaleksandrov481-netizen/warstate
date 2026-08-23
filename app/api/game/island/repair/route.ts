import { getGameSnapshot } from "@/lib/game";
import { repairIsland } from "@/lib/islands";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const amount = Number(body.amount || 25);
    if (!stateId) throw new Error("stateId is required");

    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!["president", "minister"].includes(member.role)) {
      throw new Error("Ремонт из казны запускает президент или министр.");
    }

    const repair = await repairIsland(stateId, amount);
    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, repair });
  } catch (error) {
    return jsonError(error);
  }
}
