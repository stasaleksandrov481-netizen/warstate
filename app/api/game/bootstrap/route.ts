import { bootstrapGame } from "@/lib/game";
import { jsonError, sessionFromRequest } from "@/lib/request-auth";
import { parseGroupStartParam } from "@/lib/telegram";
import { assertBotOpenForUser } from "@/lib/bot-maintenance";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = sessionFromRequest(request);
    await assertBotOpenForUser(session.user.id);
    const chatId = parseGroupStartParam(session.startParam);
    if (session.startParam && chatId === null) throw new Error("Некорректная Telegram-привязка запуска.");
    const snapshot = await bootstrapGame(session.user, chatId);
    snapshot.startParam = session.startParam || null;
    return Response.json(snapshot);
  } catch (error) {
    return jsonError(error);
  }
}
