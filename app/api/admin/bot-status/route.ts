import { getBotStatus, setBotStatus } from "@/lib/bot-maintenance";
import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) throw new Error("Нет прав доступа к управлению ботом.");
    const body = await request.json().catch(() => ({}));
    if (body?.action === "status") return Response.json(await getBotStatus());
    if (body?.action === "set") {
      const enabled = Boolean(body?.enabled);
      return Response.json(await setBotStatus({ enabled, reason: body?.reason ? String(body.reason) : null, adminTelegramId: session.user.id }));
    }
    throw new Error("Неизвестное действие.");
  } catch (error) {
    return jsonError(error);
  }
}
