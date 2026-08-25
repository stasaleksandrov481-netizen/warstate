import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { addAllianceBattleSupport } from "@/lib/strategy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const battleId = String(body.battleId || "");
    const side = body.side === "attacker" ? "attacker" : body.side === "defender" ? "defender" : null;
    if (!stateId || !battleId || !side) throw new Error("stateId, battleId and side are required");
    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!["president", "minister", "deputy", "curator"].includes(member.role)) throw new Error("Союзную поддержку может отправить руководство государства.");
    const result = await addAllianceBattleSupport(battleId, stateId, player.id, side);
    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, result });
  } catch (error) {
    return jsonError(error);
  }
}
