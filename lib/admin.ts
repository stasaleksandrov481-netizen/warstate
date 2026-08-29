import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";

export interface AdminTopState {
  name: string;
  rating: number;
  activePlayerCount: number;
  telegramChatId: number;
}

export interface AdminRecentPayment {
  sku: string;
  stars: number;
  createdAt: string;
  playerName: string | null;
}

export interface AdminBroadcastResult {
  targeted: number;
  sent: number;
  failed: number;
  failedChats: Array<{ name: string; error: string }>;
}

export interface AdminBroadcastTarget {
  id: string;
  name: string;
  stateUsername: string | null;
  telegramChatId: number;
}

// Lists candidate chats for the admin panel's "pick specific chats" mode.
// Only chats the bot can actually still reach are offered — a state hidden
// by markStateBotRemoved() would just fail to send anyway.
export async function searchBroadcastTargets(query: string, limit = 30): Promise<AdminBroadcastTarget[]> {
  const supabase = getSupabaseAdmin();
  const q = String(query || "").trim().replace(/^@/, "");
  let builder = supabase
    .from("states")
    .select("id,name,state_username,telegram_chat_id")
    .eq("is_freeport", false)
    .eq("bot_present", true)
    .not("telegram_chat_id", "is", null)
    .order("name", { ascending: true })
    .limit(Math.max(1, Math.min(50, limit)));
  if (q.length >= 1) {
    const safe = q.replace(/[^a-zA-Z0-9_а-яА-ЯёЁ -]/g, "").slice(0, 32);
    builder = builder.or(`name.ilike.%${safe}%,state_username.ilike.%${safe}%`);
  }
  const { data, error } = await builder;
  if (error) throw error;
  return (data || []).map((row: any) => ({
    id: String(row.id),
    name: String(row.name),
    stateUsername: row.state_username ? String(row.state_username) : null,
    telegramChatId: Number(row.telegram_chat_id),
  }));
}

// Sends one message to state Telegram group chats. By default every state
// (minus Freeport and states whose bot was kicked — bot_present=false, see
// markStateBotRemoved) is targeted; pass stateIds to send to a hand-picked
// subset instead. `signed` prepends the standard administration header.
// Delivery uses bounded batches so a large broadcast does not spend the whole
// Vercel request budget waiting on one Telegram round-trip at a time.
export async function broadcastAdminMessage(
  text: string,
  options: { stateIds?: string[]; signed?: boolean } = {},
): Promise<AdminBroadcastResult> {
  const message = String(text || "").trim();
  if (!message) throw new Error("Пустое сообщение.");
  if (message.length > 3500) throw new Error("Сообщение слишком длинное (максимум 3500 символов).");

  const supabase = getSupabaseAdmin();
  let builder = supabase
    .from("states")
    .select("name,telegram_chat_id")
    .eq("is_freeport", false)
    .eq("bot_present", true)
    .not("telegram_chat_id", "is", null);
  const stateIds = (options.stateIds || []).map((id) => String(id).trim()).filter(Boolean);
  if (stateIds.length) builder = builder.in("id", stateIds);
  const { data: states, error } = await builder;
  if (error) throw error;

  const targets = states || [];
  if (stateIds.length && !targets.length) {
    throw new Error("Ни один из выбранных чатов не доступен для отправки (проверьте, что бот в нём состоит).");
  }
  const result: AdminBroadcastResult = { targeted: targets.length, sent: 0, failed: 0, failedChats: [] };
  const body = options.signed === false
    ? message
    : `📣 СООБЩЕНИЕ ОТ АДМИНИСТРАЦИИ WARSTATE\n────────────\n${message}`;

  const batchSize = 18;
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize);
    const outcomes = await Promise.all(batch.map(async (state: any) => {
      try {
        await telegramApi("sendMessage", { chat_id: Number(state.telegram_chat_id), text: body });
        return { ok: true as const, state };
      } catch (sendError) {
        return { ok: false as const, state, error: sendError };
      }
    }));

    for (const outcome of outcomes) {
      if (outcome.ok) {
        result.sent += 1;
      } else {
        result.failed += 1;
        result.failedChats.push({
          name: String(outcome.state.name || outcome.state.telegram_chat_id),
          error: outcome.error instanceof Error ? outcome.error.message : "Неизвестная ошибка",
        });
      }
    }

    // Stay below Telegram's global bot throughput while avoiding a slow
    // fully-serial loop. 18 messages per ~850 ms is comfortably conservative.
    if (offset + batchSize < targets.length) {
      await new Promise((resolve) => setTimeout(resolve, 850));
    }
  }

  return result;
}

export interface AdminStats {
  generatedAt: string;
  states: {
    total: number;
    newLast7d: number;
  };
  players: {
    total: number;
    active24h: number;
    active7d: number;
    newLast7d: number;
  };
  battles: {
    total: number;
    last24h: number;
  };
  botActivity: {
    updates24h: number;
    updates7d: number;
    activityEvents24h: number;
  };
  payments: {
    count: number;
    starsTotal: number;
    starsLast7d: number;
    recent: AdminRecentPayment[];
  };
  topStates: AdminTopState[];
}

// All counts use head:true (no row transfer) and lists are hard-limited, so this
// stays cheap on Supabase's free-tier request/row quotas even as the game grows.
export async function getAdminStats(): Promise<AdminStats> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    statesTotal,
    statesNew7d,
    playersTotal,
    playersActive24h,
    playersActive7d,
    playersNew7d,
    battlesTotal,
    battlesLast24h,
    updates24h,
    updates7d,
    activityEvents24h,
    paymentsCount,
    paymentTotals,
    paymentsRecent,
    topStatesRows,
  ] = await Promise.all([
    supabase.from("states").select("id", { count: "exact", head: true }).eq("is_freeport", false),
    supabase.from("states").select("id", { count: "exact", head: true }).eq("is_freeport", false).gte("created_at", since7d),
    supabase.from("players").select("id", { count: "exact", head: true }),
    supabase.from("players").select("id", { count: "exact", head: true }).gte("last_seen_at", since24h),
    supabase.from("players").select("id", { count: "exact", head: true }).gte("last_seen_at", since7d),
    supabase.from("players").select("id", { count: "exact", head: true }).gte("created_at", since7d),
    supabase.from("battles").select("id", { count: "exact", head: true }),
    supabase.from("battles").select("id", { count: "exact", head: true }).gte("created_at", since24h),
    supabase.from("telegram_update_receipts").select("update_id", { count: "exact", head: true }).gte("received_at", since24h),
    supabase.from("telegram_update_receipts").select("update_id", { count: "exact", head: true }).gte("received_at", since7d),
    supabase.from("contribution_events").select("id", { count: "exact", head: true }).eq("source", "activity").gte("created_at", since24h),
    supabase.from("payments").select("id", { count: "exact", head: true }),
    supabase.rpc("gw_admin_payment_totals"),
    supabase.from("payments").select("sku,stars,created_at,players(display_name)").order("created_at", { ascending: false }).limit(5),
    supabase.from("states").select("name,rating,active_player_count,telegram_chat_id").eq("is_freeport", false).eq("bot_present", true).order("rating", { ascending: false }).limit(5),
  ]);

  for (const result of [
    statesTotal, statesNew7d, playersTotal, playersActive24h, playersActive7d, playersNew7d,
    battlesTotal, battlesLast24h, updates24h, updates7d, activityEvents24h, paymentsCount,
    paymentTotals, paymentsRecent, topStatesRows,
  ]) {
    if (result.error) throw result.error;
  }

  const paymentAggregate = (paymentTotals.data || {}) as { starsTotal?: number | string; starsLast7d?: number | string };
  const starsTotal = Number(paymentAggregate.starsTotal || 0);
  const starsLast7d = Number(paymentAggregate.starsLast7d || 0);

  return {
    generatedAt: now.toISOString(),
    states: {
      total: statesTotal.count || 0,
      newLast7d: statesNew7d.count || 0,
    },
    players: {
      total: playersTotal.count || 0,
      active24h: playersActive24h.count || 0,
      active7d: playersActive7d.count || 0,
      newLast7d: playersNew7d.count || 0,
    },
    battles: {
      total: battlesTotal.count || 0,
      last24h: battlesLast24h.count || 0,
    },
    botActivity: {
      updates24h: updates24h.count || 0,
      updates7d: updates7d.count || 0,
      activityEvents24h: activityEvents24h.count || 0,
    },
    payments: {
      count: paymentsCount.count || 0,
      starsTotal,
      starsLast7d,
      recent: (paymentsRecent.data || []).map((row: any) => ({
        sku: String(row.sku),
        stars: Number(row.stars || 0),
        createdAt: String(row.created_at),
        playerName: row.players?.display_name ? String(row.players.display_name) : null,
      })),
    },
    topStates: (topStatesRows.data || []).map((row: any) => ({
      name: String(row.name),
      rating: Number(row.rating || 0),
      activePlayerCount: Number(row.active_player_count || 0),
      telegramChatId: Number(row.telegram_chat_id),
    })),
  };
}
