import { searchBroadcastTargets } from "@/lib/admin";
import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) {
      throw new Error("Нет прав доступа к админ-панели.");
    }
    const body = await request.json().catch(() => ({}));
    const query = String(body?.query || "");
    const targets = await searchBroadcastTargets(query);
    return Response.json({ targets });
  } catch (error) {
    return jsonError(error);
  }
}
