import { getIslandWorld } from "@/lib/islands";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getDiplomacyForState } from "@/lib/diplomacy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const stateId = String(url.searchParams.get("stateId") || "");
    if (!stateId) throw new Error("stateId is required");
    await authorizeStateAction(request, stateId);
    const x = Number(url.searchParams.get("x") || 0);
    const y = Number(url.searchParams.get("y") || 0);
    const radius = Math.min(6000, Math.max(1000, Number(url.searchParams.get("radius") || 2600)));
    const diplomacy = await getDiplomacyForState(stateId);
    const islands = await getIslandWorld(stateId, diplomacy, { x, y }, radius);
    return Response.json({ islands });
  } catch (error) {
    return jsonError(error);
  }
}
