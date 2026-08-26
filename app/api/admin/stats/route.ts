import { getAdminStats } from "@/lib/admin";
import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) {
      throw new Error("Нет прав доступа к админ-панели.");
    }
    const stats = await getAdminStats();
    return Response.json(stats);
  } catch (error) {
    return jsonError(error);
  }
}
