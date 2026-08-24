import { redisConfigured } from "@/lib/redis";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { reconcileStateRuntime } from "@/lib/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const stateId = new URL(request.url).searchParams.get("stateId") || "";
    if (!stateId) throw new Error("stateId is required");
    await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    const maintenance = await reconcileStateRuntime(stateId, { force: true });
    const supabase = getSupabaseAdmin();
    const { data: health, error } = await supabase.rpc("gw_runtime_health", { p_state_id: stateId });
    if (error && error.code !== "PGRST202") throw error;
    return Response.json({
      ok: true,
      mode: "event-driven",
      redis: redisConfigured() ? "upstash" : "local-fallback",
      maintenance,
      health: health || null,
      at: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
