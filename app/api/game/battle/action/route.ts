import { battleAction } from "@/lib/battle";
import { authorizeBattleAction, jsonError } from "@/lib/request-auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const battleId = String(body.battleId || "");
    const action = String(body.action || "");
    if (!["move", "capture", "fire", "heal", "fortify", "class", "order"].includes(action)) throw new Error("Неизвестное боевое действие.");
    const { player, member } = await authorizeBattleAction(request, battleId);
    return Response.json(await battleAction(battleId, player.id, action, { ...body, stateId: member.state_id, role: member.role }));
  } catch (error) { return jsonError(error); }
}
