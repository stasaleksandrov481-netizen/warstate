import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";
import { requestAdminGroupAccess, resolveAdminGroupLink } from "@/lib/admin-rewards";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) throw new Error("Нет прав доступа к админ-панели.");
    const body = await request.json().catch(() => ({}));
    const stateId = String(body?.stateId || "");
    if (!stateId) throw new Error("Выберите государство.");
    const action = String(body?.action || "resolve");
    if (action === "resolve") return Response.json(await resolveAdminGroupLink(stateId));
    if (action === "request_access") {
      const requestRow = await requestAdminGroupAccess({
        stateId,
        adminTelegramId: Number(session.user.id),
        adminUsername: session.user.username ? String(session.user.username) : null,
      });
      return Response.json({ ok: true, request: requestRow });
    }
    throw new Error("Неизвестное действие с группой.");
  } catch (error) {
    return jsonError(error);
  }
}
