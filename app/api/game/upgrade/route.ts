import { getGameSnapshot, tickState, upgradeBuilding } from "@/lib/game";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import type { BuildingType } from "@/lib/types";

export const runtime = "nodejs";

const BUILDINGS: BuildingType[] = ["hq", "barracks", "mine", "refinery", "farm", "lab"];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const buildingType = body.buildingType as BuildingType;
    if (!stateId || !BUILDINGS.includes(buildingType)) throw new Error("Invalid upgrade request");

    const { player, member, session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (!['president', 'minister'].includes(member.role)) throw new Error("Развивать остров может президент или министр.");
    await upgradeBuilding(stateId, buildingType);
    await tickState(stateId);
    return Response.json(await getGameSnapshot(player.id, stateId, session.user.id, member.role));
  } catch (error) {
    return jsonError(error);
  }
}
