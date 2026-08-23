import { getBattleView } from "@/lib/battle";
import { authorizeBattleAction, jsonError } from "@/lib/request-auth";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const battleId = new URL(request.url).searchParams.get("battleId") || "";
    if (!battleId) throw new Error("battleId is required");
    const { player } = await authorizeBattleAction(request, battleId);
    return Response.json(await getBattleView(battleId, player.id));
  } catch (error) { return jsonError(error); }
}
