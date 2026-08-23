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
    const rawX = Number(url.searchParams.get("x") || 0);
    const rawY = Number(url.searchParams.get("y") || 0);
    const rawRadius = Number(url.searchParams.get("radius") || 2600);
    const x = Number.isFinite(rawX) ? Math.max(-1_000_000, Math.min(1_000_000, rawX)) : 0;
    const y = Number.isFinite(rawY) ? Math.max(-1_000_000, Math.min(1_000_000, rawY)) : 0;
    const radius = Number.isFinite(rawRadius) ? Math.min(6000, Math.max(1000, rawRadius)) : 2600;
    const diplomacy = await getDiplomacyForState(stateId);
    const islands = await getIslandWorld(stateId, diplomacy, { x, y }, radius);
    return Response.json({ islands });
  } catch (error) {
    return jsonError(error);
  }
}
