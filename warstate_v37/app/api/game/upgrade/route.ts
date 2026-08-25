import { getGameSnapshot, tickState } from "@/lib/game";
import { upgradeBuildingAction } from "@/lib/actions";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import type { BuildingType } from "@/lib/types";

export const runtime = "nodejs";

const BUILDINGS: BuildingType[] = ["hq", "barracks", "mine", "refinery", "farm", "lab", "outpost", "trade_chamber"];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const buildingType = body.buildingType as BuildingType;
    if (!stateId || !BUILDINGS.includes(buildingType)) throw new Error("Invalid upgrade request");

    const { player, member, session, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    await upgradeBuildingAction({ actorRole: member.role, stateId, buildingType, stateIsFreeport: Boolean(state.is_freeport) });
    await tickState(stateId);
    return Response.json(await getGameSnapshot(player.id, stateId, session.user.id, member.role));
  } catch (error) {
    return jsonError(error);
  }
}
