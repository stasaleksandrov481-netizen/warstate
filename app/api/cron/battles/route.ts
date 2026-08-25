import { NextRequest, NextResponse } from "next/server";
import { tickBattle } from "@/lib/battle";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: battles, error } = await supabase
    .from("battles")
    .select("id")
    .in("status", ["scheduled", "active"])
    .lte("ends_at", now)
    .order("ends_at", { ascending: true })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const settled = await Promise.allSettled((battles || []).map((battle: any) => tickBattle(String(battle.id))));
  const failed = settled.flatMap((result: PromiseSettledResult<unknown>, index: number) => result.status === "rejected"
    ? [{ battleId: String((battles || [])[index]?.id || "unknown"), error: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
    : []);

  return NextResponse.json({
    ok: failed.length === 0,
    checked: settled.length,
    resolved: settled.length - failed.length,
    failed,
    at: now,
  }, { status: failed.length ? 207 : 200 });
}
