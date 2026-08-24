import { tickBattle } from "@/lib/battle";
import { finalizeElection } from "@/lib/politics";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";

export type RuntimeMaintenanceSummary = {
  claimed: boolean;
  electionsFinalized: number;
  battlesTicked: number;
  upgradesFinished: boolean;
  strategyRefreshed: boolean;
  warnings: string[];
};

const chatMaintenanceAttempts = new Map<number, number>();

const EMPTY: RuntimeMaintenanceSummary = {
  claimed: false,
  electionsFinalized: 0,
  battlesTicked: 0,
  upgradesFinished: false,
  strategyRefreshed: false,
  warnings: [],
};

function warning(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function notifyElectionResult(stateId: string, result: any) {
  if (!result?.applied) return;
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase
    .from("states")
    .select("name,telegram_chat_id")
    .eq("id", stateId)
    .maybeSingle();
  if (stateError || !state?.telegram_chat_id) return;

  const winnerId = result?.winnerPlayerId ? String(result.winnerPlayerId) : null;
  let text = `🗳 Выборы в государстве «${state.name}» завершены.`;
  if (winnerId) {
    const { data: winner } = await supabase
      .from("players")
      .select("display_name,username")
      .eq("id", winnerId)
      .maybeSingle();
    text += `\n\nНовый президент: ${winner?.display_name || "кандидат"}${winner?.username ? ` (@${winner.username})` : ""}.`;
  } else {
    text += "\n\nПрезидент не избран: голосование завершилось без кандидата.";
  }

  await telegramApi("sendMessage", {
    chat_id: Number(state.telegram_chat_id),
    text,
  }).catch(() => undefined);
}

/**
 * Event-driven replacement for Vercel Cron.
 *
 * A PostgreSQL lease makes this safe across concurrent serverless instances.
 * The function is intentionally state-scoped and bounded, so a normal Mini App
 * refresh never scans the whole game world.
 */
export async function reconcileStateRuntime(
  stateId: string,
  options: { force?: boolean; intervalSeconds?: number } = {},
): Promise<RuntimeMaintenanceSummary> {
  if (!stateId) return { ...EMPTY };
  const supabase = getSupabaseAdmin();
  const intervalSeconds = options.force ? 1 : Math.max(10, Math.min(120, options.intervalSeconds ?? 20));

  const { data: claimed, error: claimError } = await supabase.rpc("gw_claim_state_maintenance", {
    p_state_id: stateId,
    p_interval_seconds: intervalSeconds,
  });
  if (claimError) {
    // Rolling deploy compatibility: gameplay should not die just because the new
    // maintenance migration has not been applied yet.
    if (claimError.code === "PGRST202" || String(claimError.message || "").includes("gw_claim_state_maintenance")) {
      return { ...EMPTY, warnings: ["migration_015_missing"] };
    }
    throw claimError;
  }
  if (!claimed) return { ...EMPTY };

  const summary: RuntimeMaintenanceSummary = { ...EMPTY, claimed: true, warnings: [] };

  const [electionsRes, battlesRes, upgradeRes] = await Promise.allSettled([
    supabase
      .from("state_elections")
      .select("id")
      .eq("state_id", stateId)
      .eq("status", "open")
      .lte("ends_at", new Date().toISOString())
      .order("ends_at", { ascending: true })
      .limit(3),
    supabase
      .from("battles")
      .select("id")
      .in("status", ["scheduled", "active"])
      .or(`attacker_state_id.eq.${stateId},defender_state_id.eq.${stateId}`)
      .order("ends_at", { ascending: true })
      .limit(4),
    supabase.rpc("gw_finish_building_upgrades", { p_state_id: stateId }),
  ]);

  if (upgradeRes.status === "fulfilled" && !upgradeRes.value.error) summary.upgradesFinished = true;
  else if (upgradeRes.status === "rejected") summary.warnings.push(warning(upgradeRes.reason));
  else if (upgradeRes.status === "fulfilled" && upgradeRes.value.error) summary.warnings.push(upgradeRes.value.error.message);

  // Strategy must be refreshed only after completed upgrades are applied. Running
  // both RPCs concurrently can leave army/defense/economy one tick behind the
  // newly finished building.
  try {
    const strategyRes = await supabase.rpc("gw_refresh_state_strategy", { p_state_id: stateId });
    if (!strategyRes.error) summary.strategyRefreshed = true;
    else if (strategyRes.error.code !== "PGRST202") summary.warnings.push(strategyRes.error.message);
  } catch (error) {
    summary.warnings.push(warning(error));
  }

  if (electionsRes.status === "fulfilled") {
    if (electionsRes.value.error) summary.warnings.push(electionsRes.value.error.message);
    else {
      for (const row of electionsRes.value.data || []) {
        try {
          const result = await finalizeElection(String(row.id));
          if (result?.applied) {
            summary.electionsFinalized += 1;
            await notifyElectionResult(stateId, result);
          }
        } catch (error) {
          summary.warnings.push(warning(error));
        }
      }
    }
  } else summary.warnings.push(warning(electionsRes.reason));

  if (battlesRes.status === "fulfilled") {
    if (battlesRes.value.error) summary.warnings.push(battlesRes.value.error.message);
    else {
      const ticked = await Promise.allSettled((battlesRes.value.data || []).map((row: any) => tickBattle(String(row.id))));
      for (const item of ticked) {
        if (item.status === "fulfilled") summary.battlesTicked += 1;
        else summary.warnings.push(warning(item.reason));
      }
    }
  } else summary.warnings.push(warning(battlesRes.reason));

  return summary;
}

export async function reconcileStateRuntimeByChatId(chatId: number) {
  if (!Number.isSafeInteger(chatId)) return { ...EMPTY };

  // Busy Telegram groups can produce many updates per second. Avoid spending a
  // database roundtrip on every message in the same warm serverless instance;
  // PostgreSQL still provides the cross-instance authoritative lease.
  const now = Date.now();
  const lastAttempt = chatMaintenanceAttempts.get(chatId) || 0;
  if (now - lastAttempt < 8_000) return { ...EMPTY };
  chatMaintenanceAttempts.set(chatId, now);
  if (chatMaintenanceAttempts.size > 1000) {
    for (const [key, at] of chatMaintenanceAttempts) if (now - at > 60_000) chatMaintenanceAttempts.delete(key);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("states").select("id").eq("telegram_chat_id", chatId).maybeSingle();
  if (error || !data?.id) return { ...EMPTY };
  return reconcileStateRuntime(String(data.id));
}
