import { NextRequest, NextResponse } from "next/server";
import { reconcileDynamicEventsForAllStates } from "@/lib/dynamic-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * OPTIONAL backup endpoint for the dynamic chat-events engine.
 *
 * WARSTATE stays fully event-driven: ordinary Telegram group activity already
 * reconciles anarchy timers, night mode and emergency (ЧП) deadlines exactly
 * like the rest of the v2.0 runtime. This route exists so an operator who
 * wants near-exact 23:00 night announcements or prompt ЧП-timeout messages in
 * quiet chats can schedule it externally (Vercel Cron, GitHub Actions,
 * cron-job.org, etc.) every 5–15 minutes:
 *
 *   GET /api/cron/dynamic-events
 *   Authorization: Bearer $CRON_SECRET
 *
 * No schedule is added to vercel.json on purpose (see project audit).
 */
function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limitParam = Number(new URL(request.url).searchParams.get("limit") || 150);
  const { processed, summaries } = await reconcileDynamicEventsForAllStates(limitParam);
  return NextResponse.json({
    ok: true,
    processed,
    anarchyFired: summaries.filter((item) => item.anarchyFired).length,
    nightSent: summaries.filter((item) => item.nightSent).length,
    threatsExpired: summaries.reduce((total, item) => total + item.threatsExpired, 0),
    threatSpawned: summaries.filter((item) => item.threatSpawned).length,
    roleNudgeSent: summaries.filter((item) => item.roleNudgeSent).length,
  });
}
