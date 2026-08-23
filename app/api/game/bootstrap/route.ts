import { bootstrapGame } from "@/lib/game";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";
import { parseGroupStartParam } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const startParam = body.startParam || session.startParam;
    const chatId = parseGroupStartParam(startParam);
    if (!chatId) throw new Error("Откройте GROUP WARS из Telegram-группы через кнопку бота.");
    const snapshot = await bootstrapGame(session.user, chatId);
    snapshot.startParam = startParam;
    return Response.json(snapshot);
  } catch (error) {
    return jsonError(error);
  }
}
