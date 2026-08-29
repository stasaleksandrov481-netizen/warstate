import { NextRequest, NextResponse } from "next/server";
import { finalizeDueElections } from "@/lib/government";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const results = await finalizeDueElections();
  const supabase = getSupabaseAdmin();
  const notified: string[] = [];
  for (const item of results) {
    const { data: state, error: stateError } = await supabase.from("states").select("name,telegram_chat_id").eq("id", item.stateId).maybeSingle();
    if (stateError) { console.warn("Election state lookup failed", item.stateId, stateError); continue; }
    if (!state?.telegram_chat_id) continue;
    const winnerId = item.result?.winnerPlayerId ? String(item.result.winnerPlayerId) : null;
    let text = `🗳 Выборы в государстве «${state.name}» завершены.`;
    if (winnerId) {
      const { data: winner, error: winnerError } = await supabase.from("players").select("display_name,username").eq("id", winnerId).maybeSingle();
      if (winnerError) console.warn("Election winner lookup failed", winnerId, winnerError);
      text += `\n\nНовый президент: ${winner?.display_name || "кандидат"}${winner?.username ? ` (@${winner.username})` : ""}.`;
    } else {
      text += "\n\nПрезидент не избран: голосование завершилось без кандидата.";
    }
    try {
      await telegramApi("sendMessage", { chat_id: Number(state.telegram_chat_id), text });
      notified.push(String(item.electionId));
    } catch (error) {
      console.warn("Election notification failed", item.electionId, error);
    }
  }
  return NextResponse.json({ ok: true, finalized: results.length, notified: notified.length, results });
}
