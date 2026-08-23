import { joinBattle } from "@/lib/battle";
import { authorizeBattleAction, jsonError } from "@/lib/request-auth";
import type { BattleClass } from "@/lib/types";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const battleId = String(body.battleId || "");
    const klass = String(body.class || "assault") as BattleClass;
    const { player, member } = await authorizeBattleAction(request, battleId);
    return Response.json(await joinBattle(battleId, player.id, member.state_id, klass));
  } catch (error) { return jsonError(error); }
}
