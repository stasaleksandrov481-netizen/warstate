import { broadcastAdminMessage } from "@/lib/admin";
import { isProjectAdminTelegramId } from "@/lib/config";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";
// A full broadcast is a sequential loop over every state chat (see
// broadcastAdminMessage), so give it real headroom for large worlds instead
// of the default short function timeout.
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    if (!isProjectAdminTelegramId(session.user.id)) {
      throw new Error("Нет прав доступа к админ-панели.");
    }
    const body = await request.json().catch(() => ({}));
    const text = String(body?.text || "");
    const result = await broadcastAdminMessage(text);
    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
