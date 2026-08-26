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

// Sends one message to every registered state's Telegram group chat.
// Freeport (chat_id 0, not a real chat) and states whose bot was kicked
// (bot_present=false — see markStateBotRemoved) are skipped, since Telegram
// would just reject the send. Fired sequentially with a small delay between
// sends to stay comfortably under Telegram's ~30 msg/sec global rate limit
// without needing a queue for what is an occasional, admin-only action.
export async function broadcastAdminMessage(text: string): Promise<AdminBroadcastResult> {
  const message = String(text || "").trim();
  if (!message) throw new Error("Пустое сообщение.");
  if (message.length > 3500) throw new Error("Сообщение слишком длинное (максимум 3500 символов).");

  const supabase = getSupabaseAdmin();
  const { data: states, error } = await supabase
    .from("states")
    .select("name,telegram_chat_id")
    .eq("is_freeport", false)
    .eq("bot_present", true)
    .not("telegram_chat_id", "is", null);
  if (error) throw error;

  const targets = states || [];
  const result: AdminBroadcastResult = { targeted: targets.length, sent: 0, failed: 0, failedChats: [] };
  const body = `📣 СООБЩЕНИЕ ОТ АДМИНИСТРАЦИИ WARSTATE\n────────────\n${message}`;

  for (const state of targets) {
    try {
      await telegramApi("sendMessage", { chat_id: Number(state.telegram_chat_id), text: body });
      result.sent += 1;
    } catch (sendError) {
      result.failed += 1;
      result.failedChats.push({
        name: String(state.name || state.telegram_chat_id),
        error: sendError instanceof Error ? sendError.message : "Неизвестная ошибка",
      });
    }
    // Telegram's global bot rate limit is roughly 30 messages/second across
    // all chats. 40ms between sends keeps a large broadcast well under that
    // without needing exponential backoff for a one-off admin action.
    await new Promise((resolve) => setTimeout(resolve, 40));
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
    paymentsRows,
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
    // Payment amounts are summed in JS: Supabase's free-tier PostgREST has no
    // server-side aggregate here, and payment volume on a hobby bot is small.
    supabase.from("payments").select("stars,created_at").order("created_at", { ascending: false }).limit(2000),
    supabase.from("payments").select("sku,stars,created_at,players(display_name)").order("created_at", { ascending: false }).limit(5),
    supabase.from("states").select("name,rating,active_player_count,telegram_chat_id").eq("is_freeport", false).eq("bot_present", true).order("rating", { ascending: false }).limit(5),
  ]);

  for (const result of [
    statesTotal, statesNew7d, playersTotal, playersActive24h, playersActive7d, playersNew7d,
    battlesTotal, battlesLast24h, updates24h, updates7d, activityEvents24h, paymentsCount,
    paymentsRows, paymentsRecent, topStatesRows,
  ]) {
    if (result.error) throw result.error;
  }

  const starsTotal = (paymentsRows.data || []).reduce((sum, row: any) => sum + Number(row.stars || 0), 0);
  const starsLast7d = (paymentsRows.data || [])
    .filter((row: any) => row.created_at >= since7d)
    .reduce((sum, row: any) => sum + Number(row.stars || 0), 0);

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
