import { getGameSnapshot } from "@/lib/game";
import { repairIsland } from "@/lib/islands";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const rawAmount = Number(body.amount ?? 25);
    if (!stateId) throw new Error("stateId is required");
    if (!Number.isFinite(rawAmount)) throw new Error("Некорректный объём ремонта.");
    const amount = Math.max(1, Math.min(50, Math.round(rawAmount)));

    const { player, member, session, state } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (state.is_freeport) throw new Error("Freeport не нуждается в ремонте игроков.");
    if (!["president", "minister", "deputy", "curator"].includes(member.role)) {
      throw new Error("Ремонт из казны запускает президент, заместитель или куратор.");
    }

    const repair = await repairIsland(stateId, amount);
    const snapshot = await getGameSnapshot(player.id, stateId, session.user.id, member.role);
    return Response.json({ snapshot, repair });
  } catch (error) {
    return jsonError(error);
  }
}
