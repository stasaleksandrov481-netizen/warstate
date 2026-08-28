import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";
import { getAdminRewardHistory, grantAdminReward, searchAdminStates, searchAdminStateMembers, sendAdminStateMessage, type AdminRewardType } from "@/lib/admin-rewards";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) throw new Error("Нет прав доступа к админ-панели.");
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    const adminUsername = session.user.username ? String(session.user.username) : null;

    if (action === "states") {
      return Response.json({ states: await searchAdminStates(String(body?.query || "")) });
    }
    if (action === "members") {
      const stateId = String(body?.stateId || "");
      if (!stateId) throw new Error("Выберите государство.");
      return Response.json({ members: await searchAdminStateMembers(stateId, String(body?.query || "")) });
    }
    if (action === "history") {
      const stateId = body?.stateId ? String(body.stateId) : null;
      return Response.json({ history: await getAdminRewardHistory(stateId) });
    }
    if (action === "grant") {
      const stateId = String(body?.stateId || "");
      const rewardType = String(body?.rewardType || "") as AdminRewardType;
      if (!stateId || !rewardType) throw new Error("Выберите государство и тип награды.");
      const result = await grantAdminReward({
        adminTelegramId: Number(session.user.id),
        adminUsername,
        stateId,
        playerId: body?.playerId ? String(body.playerId) : null,
        rewardType,
        amount: Number(body?.amount || 0),
        parameters: body?.parameters && typeof body.parameters === "object" ? body.parameters : {},
        reason: body?.reason ? String(body.reason) : null,
      });
      return Response.json(result);
    }
    if (action === "message") {
      const stateId = String(body?.stateId || "");
      if (!stateId) throw new Error("Выберите государство.");
      return Response.json(await sendAdminStateMessage({
        adminTelegramId: Number(session.user.id),
        adminUsername,
        stateId,
        text: String(body?.text || ""),
      }));
    }
    throw new Error("Неизвестное действие админ-панели.");
  } catch (error) {
    return jsonError(error);
  }
}
