import { claimDailyMission } from "@/lib/missions";
import { getGameSnapshot } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const missionId = String(body.missionId || "");
    if (!stateId || !missionId) throw new Error("Некорректное задание.");
    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    await claimDailyMission(player.id, stateId, missionId);
    return Response.json(await getGameSnapshot(player.id, stateId, session.user.id, member.role));
  } catch (error) {
    return jsonError(error);
  }
}
