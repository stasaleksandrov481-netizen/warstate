import { getSupabaseAdmin } from "@/lib/supabase/server";
import { telegramApi } from "@/lib/telegram-bot";

/**
 * WARSTATE dynamic events engine (v4.0).
 *
 * Chat-driven pressure loop that keeps every state chat alive:
 *  - 2-hour President vacancy timer → anarchy notification + real losses;
 *  - night mode announcement at 23:00 (ЧП paused until 08:00);
 *  - random daytime emergencies every 3 hours with interactive button
 *    reactions and a limited response window;
 *  - periodic reminders while key specializations (Шахтёр / Шпион) are unset.
 *
 * Fully event-driven, exactly like lib/maintenance.ts: live Telegram activity
 * triggers reconciliation, and every state mutation is an atomic
 * UPDATE ... WHERE claim so concurrent serverless instances can never
 * double-fire anarchy, spawn duplicate threats or double-apply losses.
 * PostgreSQL stays the single source of truth.
 */

// ---------------------------------------------------------------------------
// Timing rules
// ---------------------------------------------------------------------------
export const PRESIDENT_VACANCY_GRACE_MS = 2 * 60 * 60_000;
export const ANARCHY_REPEAT_MS = 2 * 60 * 60_000;
export const THREAT_RESPONSE_WINDOW_MS = 10 * 60_000;
export const ROLE_NUDGE_INTERVAL_MS = 2 * 60 * 60_000;
export const ELECTION_REMINDER_INTERVAL_MS = 5 * 60_000;

/** Local hours (game timezone) when a new emergency may spawn: 08/11/14/17/20. */
const THREAT_SLOT_HOURS = [8, 11, 14, 17, 20] as const;
const NIGHT_START_HOUR = 23;
const NIGHT_END_HOUR = 8;

const MESSAGE_DIVIDER = "────────────";

export function gameTimeZone(): string {
  const tz = String(process.env.WARSTATE_TIMEZONE || "").trim();
  if (!tz) return "Europe/Moscow";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "Europe/Moscow";
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Convert a wall-clock time in `timeZone` into the matching UTC instant. */
function localWallClockToUtc(parts: LocalParts, hour: number, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0);
  let guess = target;
  // Iterate until the wall-clock reading of the guess equals the target.
  // Two to three iterations converge even across DST transitions.
  for (let i = 0; i < 3; i += 1) {
    const shifted = localParts(new Date(guess), timeZone);
    const wallAsUtc = Date.UTC(shifted.year, shifted.month - 1, shifted.day, shifted.hour, shifted.minute, 0);
    const offset = wallAsUtc - guess; // timezone offset at the guessed instant
    const candidate = target - offset;
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

/** Next 3-hour emergency slot strictly after `date` (game timezone). */
export function nextThreatSlotAfter(date: Date, timeZone: string): Date {
  const parts = localParts(date, timeZone);
  for (const slotHour of THREAT_SLOT_HOURS) {
    if (parts.hour < slotHour) return localWallClockToUtc(parts, slotHour, timeZone);
  }
  const tomorrowParts = localParts(new Date(date.getTime() + 24 * 60 * 60_000), timeZone);
  return localWallClockToUtc(tomorrowParts, 8, timeZone);
}

/**
 * Identifier of the current night (YYYY-MM-DD of the evening) or null during
 * the day. 23:00-23:59 of day D and 00:00-07:59 of day D+1 share one id.
 */
export function currentNightId(date: Date, timeZone: string): string | null {
  const parts = localParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  const formatDate = (p: LocalParts) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (parts.hour >= NIGHT_START_HOUR) return formatDate(parts);
  if (parts.hour < NIGHT_END_HOUR) {
    const yesterdayParts = localParts(new Date(date.getTime() - 24 * 60 * 60_000), timeZone);
    return formatDate(yesterdayParts);
  }
  return null;
}

export function isNightHour(date: Date, timeZone: string): boolean {
  return currentNightId(date, timeZone) !== null;
}

// ---------------------------------------------------------------------------
// Emergency catalog
// ---------------------------------------------------------------------------
export type ThreatKind = "raid" | "phenomenon" | "riot" | "intrigue" | "disaster";

export interface ThreatOption {
  action: string;
  label: string;
  successText: string;
}

export interface ThreatTemplate {
  kind: ThreatKind;
  title: string;
  shortTitle: string;
  body: (stateName: string) => string;
  failureText: string;
  options: [ThreatOption, ThreatOption];
}

export const THREAT_TEMPLATES: ThreatTemplate[] = [
  {
    kind: "raid",
    title: "🚨 ЧП · НАБЕГ РЕЙДЕРОВ",
    shortTitle: "НАБЕГ РЕЙДЕРОВ",
    body: (name) =>
      `На окраинах государства «${name}» замечены вооружённые рейдеры. Они уже подбираются к складам с ресурсами. Если государство не отреагирует — мародёры разграбят запасы, и казна уйдёт в минус.`,
    failureText: "Рейдеры разграбили склады и скрылись с добычей.",
    options: [
      { action: "repel", label: "⚔️ Отразить атаку", successText: "Рейдеры отброшены за границы государства!" },
      { action: "fortify", label: "🛡️ Укрепить оборону", successText: "Оборона выдержала натиск — рейдеры отступили ни с чем." },
    ],
  },
  {
    kind: "phenomenon",
    title: "🚨 ЧП · РЕДКОЕ ЯВЛЕНИЕ",
    shortTitle: "РЕДКОЕ ЯВЛЕНИЕ",
    body: (name) =>
      `Над островом государства «${name}» зависло необъяснимое явление. Граждане в панике, учёные требуют немедленной реакции. Без действий явление нарушит инфраструктуру и нанесёт экономике серьёзный урон.`,
    failureText: "Явление спровоцировало аварии на инфраструктуре острова.",
    options: [
      { action: "study", label: "🔭 Изучить явление", successText: "Явление изучено — государство обращает его на пользу науки!" },
      { action: "track", label: "🛰️ Отследить траекторию", successText: "Траектория просчитана — ущерб полностью предотвращён." },
    ],
  },
  {
    kind: "riot",
    title: "🚨 ЧП · БУНТ В ГОСУДАРСТВЕ",
    shortTitle: "БУНТ",
    body: (name) =>
      `На площадях государства «${name}» начался бунт: граждане требуют объяснений от власти. Ситуация накаляется с каждой минутой. Если не вмешаться — беспорядки остановят добычу ресурсов и разорят казну.`,
    failureText: "Беспорядки остановили работу шахт и ферм на долгие часы.",
    options: [
      { action: "calm", label: "🕊️ Утихомирить толпу", successText: "Переговоры завершены — толпа разошлась по домам." },
      { action: "feed", label: "🍞 Открыть продовольственные склады", successText: "Склады открыты — недовольство граждан погашено." },
    ],
  },
  {
    kind: "intrigue",
    title: "🚨 ЧП · ЭКОНОМИЧЕСКАЯ ИНТРИГА",
    shortTitle: "ЭКОНОМИЧЕСКАЯ ИНТРИГА",
    body: (name) =>
      `Казначейство государства «${name}» обнаружило подозрительные махинации: кто-то выводит ресурсы через подставные контракты. След остывает быстро — действуйте, иначе казна уйдёт в глубокий минус.`,
    failureText: "Схема с выводом ресурсов сработала — казна понесла тяжёлый удар.",
    options: [
      { action: "investigate", label: "🕵️ Вычислить саботажника", successText: "Саботажник разоблачён и изгнан — утечка ресурсов остановлена!" },
      { action: "audit", label: "📊 Провести срочный аудит", successText: "Аудит завершён — сомнительные контракты расторгнуты." },
    ],
  },
  {
    kind: "disaster",
    title: "🚨 ЧП · ПРИРОДНЫЙ КАТАКЛИЗМ",
    shortTitle: "ПРИРОДНЫЙ КАТАКЛИЗМ",
    body: (name) =>
      `На государство «${name}» обрушился стихийный катаклизм: разрушены коммуникации, пострадали склады. Промедление с помощью приведёт к тяжёлым убыткам для всей экономики.`,
    failureText: "Стихия довершила своё дело — коммуникации и склады разрушены.",
    options: [
      { action: "rescue", label: "🚑 Организовать помощь пострадавшим", successText: "Помощь организована — граждане спасены, паника предотвращена." },
      { action: "rebuild", label: "🏗️ Начать восстановительные работы", successText: "Восстановительные работы начаты — ущерб минимизирован." },
    ],
  },
];

const THREAT_TEMPLATE_BY_KIND = new Map<string, ThreatTemplate>(
  THREAT_TEMPLATES.map((template) => [template.kind, template]),
);

export function threatTemplate(kind: string): ThreatTemplate | null {
  return THREAT_TEMPLATE_BY_KIND.get(kind) || null;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------
async function sendChatMessage(chatId: number, text: string, keyboard?: Array<Array<{ text: string; callback_data: string }>>) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------
interface DynamicStateRow {
  id: string;
  name: string;
  telegram_chat_id: number | null;
  owner_player_id: string | null;
  president_vacant_since: string | null;
  last_anarchy_at: string | null;
  night_notified_on: string | null;
  next_threat_at: string | null;
  last_role_nudge_at: string | null;
  is_freeport: boolean | null;
  is_beginner_island: boolean | null;
  bot_present: boolean | null;
}

const DYNAMIC_STATE_COLUMNS = "id,name,telegram_chat_id,owner_player_id,president_vacant_since,last_anarchy_at,night_notified_on,next_threat_at,last_role_nudge_at,is_freeport,is_beginner_island,bot_present";

function isMissingMigrationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown };
  const code = String(row.code || "");
  const message = String(row.message || "");
  // PGRST202: function missing, PGRST204/205: column/relation missing.
  return ["PGRST202", "PGRST204", "PGRST205"].includes(code)
    || message.includes("gw_apply_state_loss")
    || message.includes("state_threat_events")
    || message.includes("president_vacant_since");
}

function warnOptional(step: string, error: unknown) {
  if (isMissingMigrationError(error)) {
    console.warn(`WARSTATE dynamic events skipped (${step}): apply migration 032_dynamic_events.sql`);
    return;
  }
  console.warn(`WARSTATE dynamic events step failed (${step})`, error);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
const reconcileAttempts = new Map<string, number>();
const RECONCILE_THROTTLE_MS = 20_000;

export interface DynamicEventsSummary {
  anarchyFired: boolean;
  nightSent: boolean;
  threatsExpired: number;
  threatSpawned: boolean;
  roleNudgeSent: boolean;
  electionReminderSent: boolean;
}

const EMPTY_SUMMARY: DynamicEventsSummary = {
  anarchyFired: false,
  nightSent: false,
  threatsExpired: 0,
  threatSpawned: false,
  roleNudgeSent: false,
  electionReminderSent: false,
};

/** Load the state row for a Telegram chat, or null when unregistered. */
async function loadStateByChat(chatId: number): Promise<DynamicStateRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select(DYNAMIC_STATE_COLUMNS)
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) {
    warnOptional("load state", error);
    return null;
  }
  return (data || null) as DynamicStateRow | null;
}

export function dynamicEventsEligible(state: DynamicStateRow): boolean {
  return Boolean(state.telegram_chat_id)
    && !state.is_freeport
    && !state.is_beginner_island
    && state.bot_present !== false;
}

/**
 * Initialize trackers right after the bot is added to a chat:
 * the 2-hour President vacancy countdown starts at add-time, and the
 * emergency scheduler is armed with the next daytime slot.
 */
export async function initializeDynamicTrackers(chatId: number) {
  try {
    const state = await loadStateByChat(chatId);
    if (!state || !dynamicEventsEligible(state)) return;
    const supabase = getSupabaseAdmin();
    const now = new Date();
    if (!state.owner_player_id && !state.president_vacant_since) {
      await supabase
        .from("states")
        .update({ president_vacant_since: now.toISOString() })
        .eq("id", state.id)
        .is("owner_player_id", null)
        .is("president_vacant_since", null);
    }
    if (!state.next_threat_at) {
      await supabase
        .from("states")
        .update({ next_threat_at: nextThreatSlotAfter(now, gameTimeZone()).toISOString() })
        .eq("id", state.id)
        .is("next_threat_at", null);
    }
  } catch (error) {
    warnOptional("initialize trackers", error);
  }
}

/**
 * Event-driven reconciliation triggered by live Telegram chat activity.
 * Cheap on busy chats thanks to a per-instance throttle; correctness across
 * concurrent instances is guaranteed by atomic UPDATE claims in PostgreSQL.
 */
export async function reconcileDynamicEventsForChat(chatId: number): Promise<DynamicEventsSummary> {
  if (!Number.isSafeInteger(chatId)) return { ...EMPTY_SUMMARY };
  const state = await loadStateByChat(chatId);
  if (!state) return { ...EMPTY_SUMMARY };
  return reconcileDynamicEventsForState(state, { throttle: true });
}

/**
 * Reconcile by state row. Used by both the chat path and the optional backup
 * cron endpoint (which bypasses the per-instance throttle because each state
 * is visited at most once per cron invocation).
 */
export async function reconcileDynamicEventsForState(
  state: DynamicStateRow,
  options: { throttle?: boolean } = {},
): Promise<DynamicEventsSummary> {
  const summary: DynamicEventsSummary = { ...EMPTY_SUMMARY };
  if (!dynamicEventsEligible(state)) return summary;

  if (options.throttle) {
    const now = Date.now();
    const lastAttempt = reconcileAttempts.get(state.id) || 0;
    if (now - lastAttempt < RECONCILE_THROTTLE_MS) return summary;
    reconcileAttempts.set(state.id, now);
    if (reconcileAttempts.size > 1000) {
      for (const [key, at] of reconcileAttempts) if (now - at > 120_000) reconcileAttempts.delete(key);
    }
  }

  const chatId = Number(state.telegram_chat_id);
  const now = new Date();
  const timeZone = gameTimeZone();

  // 1. Keep the President-vacancy tracker in sync with reality.
  await syncPresidentVacancy(state);

  // 2. Anarchy: the vacancy timer does not sleep at night.
  summary.anarchyFired = await maybeApplyAnarchy(state, chatId, now);

  // 2b. Election reminders: while a vote is open, nudge the chat every 5
  //     minutes (this also does not sleep at night — same reasoning as anarchy).
  summary.electionReminderSent = await maybeRemindElection(state, chatId, now);

  // 3. Night mode: announce once per night and pause ЧП until 08:00.
  const nightId = currentNightId(now, timeZone);
  if (nightId) {
    summary.nightSent = await maybeSendNightNotification(state, chatId, nightId);
    // "ЧП временно прекращаются до 08:00": any emergency still open when the
    // night begins is closed without losses and without extra messages.
    await cancelThreatsForNight(state);
    return summary;
  }

  // 4. Daytime: settle expired emergencies first so failures are visible
  //    before anything new spawns.
  summary.threatsExpired = await expireDueThreats(state, chatId, now);

  // 5. Spawn the due emergency for the current 3-hour slot.
  summary.threatSpawned = await maybeSpawnThreat(state, chatId, now, timeZone);

  // 6. Remind about unassigned key specializations.
  summary.roleNudgeSent = await maybeNudgeRoles(state, chatId, now);

  return summary;
}

/**
 * Reconcile every eligible state (backup cron endpoint). States are processed
 * in small bounded batches so a single request stays well within serverless
 * limits even on a large world.
 */
export async function reconcileDynamicEventsForAllStates(limit = 150): Promise<{
  processed: number;
  summaries: DynamicEventsSummary[];
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select(DYNAMIC_STATE_COLUMNS)
    .eq("bot_present", true)
    .eq("is_freeport", false)
    .eq("is_beginner_island", false)
    .not("telegram_chat_id", "is", null)
    .order("next_threat_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(1, Math.min(500, limit)));
  if (error) {
    warnOptional("load states batch", error);
    return { processed: 0, summaries: [] };
  }
  const summaries: DynamicEventsSummary[] = [];
  for (const row of (data || []) as DynamicStateRow[]) {
    summaries.push(await reconcileDynamicEventsForState(row, { throttle: false }));
  }
  return { processed: summaries.length, summaries };
}

// ---------------------------------------------------------------------------
// President vacancy + anarchy
// ---------------------------------------------------------------------------
async function syncPresidentVacancy(state: DynamicStateRow) {
  try {
    const supabase = getSupabaseAdmin();
    if (!state.owner_player_id && !state.president_vacant_since) {
      // The post is vacant and no countdown is running: start the 2-hour
      // timer now (covers both first bot-add and any later power vacuum).
      await supabase
        .from("states")
        .update({ president_vacant_since: new Date().toISOString() })
        .eq("id", state.id)
        .is("owner_player_id", null)
        .is("president_vacant_since", null);
      state.president_vacant_since = new Date().toISOString();
    } else if (state.owner_player_id && state.president_vacant_since) {
      // A President is in office: cancel the countdown and reset the anarchy
      // clock so a future vacancy starts a fresh 2-hour grace period.
      await supabase
        .from("states")
        .update({ president_vacant_since: null, last_anarchy_at: null })
        .eq("id", state.id)
        .not("owner_player_id", "is", null)
        .not("president_vacant_since", "is", null);
      state.president_vacant_since = null;
      state.last_anarchy_at = null;
    }
  } catch (error) {
    warnOptional("vacancy sync", error);
  }
}

async function maybeApplyAnarchy(state: DynamicStateRow, chatId: number, now: Date): Promise<boolean> {
  if (state.owner_player_id) return false;
  try {
    const supabase = getSupabaseAdmin();
    const graceCutoff = new Date(now.getTime() - PRESIDENT_VACANCY_GRACE_MS).toISOString();
    const repeatCutoff = new Date(now.getTime() - ANARCHY_REPEAT_MS).toISOString();

    // Atomic claim: fires once when the 2-hour grace expires and then at
    // most once every further 2 hours while the vacuum persists. Two
    // guarded UPDATEs are used instead of an OR filter so no PostgREST
    // filter-value parsing can ever cause a double fire.
    const claimFilters = (query: any) => query
      .eq("id", state.id)
      .is("owner_player_id", null)
      .not("president_vacant_since", "is", null)
      .lte("president_vacant_since", graceCutoff);
    let claimed: { id: string; name?: string } | null = null;
    // Path 1: anarchy has never fired for this vacancy.
    const first = await claimFilters(supabase.from("states").update({ last_anarchy_at: now.toISOString() }))
      .is("last_anarchy_at", null)
      .select("id,name")
      .maybeSingle();
    if (first.error) {
      warnOptional("anarchy claim", first.error);
      return false;
    }
    if (first.data) {
      claimed = first.data as { id: string; name?: string };
    } else {
      // Path 2: previous wave fired more than 2 hours ago (NULL never
      // matches .lte, so this cannot double-fire after path 1).
      const repeat = await claimFilters(supabase.from("states").update({ last_anarchy_at: now.toISOString() }))
        .lte("last_anarchy_at", repeatCutoff)
        .select("id,name")
        .maybeSingle();
      if (repeat.error) {
        warnOptional("anarchy repeat claim", repeat.error);
        return false;
      }
      claimed = (repeat.data || null) as { id: string; name?: string } | null;
    }
    if (!claimed) return false;

    // Real losses: resources are drained and the running deficit grows. The
    // chat message intentionally never reveals the exact figures.
    try {
      await supabase.rpc("gw_apply_state_loss", { p_state_id: state.id, p_profile: "anarchy" });
    } catch (lossError) {
      warnOptional("anarchy loss", lossError);
    }

    const stateName = String(claimed.name || state.name);
    const text =
      `🔥 АНАРХИЯ В ГОСУДАРСТВЕ «${stateName}»\n${MESSAGE_DIVIDER}\n` +
      `Прошло 2 часа, а Президент так и не избран. Из-за отсутствия власти в стране началась анархия: мародёры грабят склады, чиновники разбежались, экономика парализована.\n\n` +
      `Государство понесло потери и ушло в минус. С каждыми новыми 2 часами безвластия потери будут расти.\n\n` +
      `🏛 Наведите порядок: чтобы начать выборы, отправьте команду !выборы`;
    try {
      await sendChatMessage(chatId, text);
    } catch (sendError) {
      console.warn("WARSTATE anarchy notification skipped", sendError);
    }
    return true;
  } catch (error) {
    warnOptional("anarchy", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Night mode
// ---------------------------------------------------------------------------
const NIGHT_MESSAGE =
  "🌙 В государстве наступила ночь. Войска отправляются на отдых, а ЧП временно прекращаются до 08:00. Готовьтесь к новым вызовам утром!";

async function maybeSendNightNotification(state: DynamicStateRow, chatId: number, nightId: string): Promise<boolean> {
  if (state.night_notified_on === nightId) return false;
  try {
    const supabase = getSupabaseAdmin();
    // Atomic claim (two guarded UPDATEs, no OR filter): exactly one instance
    // announces a given night. Path 1 covers never-announced states, path 2
    // re-arms after a previous night (NULL never matches .neq).
    const baseFilters = (query: any) => query.eq("id", state.id);
    let claimed: { id: string } | null = null;
    const first = await baseFilters(supabase.from("states").update({ night_notified_on: nightId }))
      .is("night_notified_on", null)
      .select("id")
      .maybeSingle();
    if (first.error) {
      warnOptional("night claim", first.error);
      return false;
    }
    if (first.data) {
      claimed = first.data as { id: string };
    } else {
      const repeat = await baseFilters(supabase.from("states").update({ night_notified_on: nightId }))
        .neq("night_notified_on", nightId)
        .select("id")
        .maybeSingle();
      if (repeat.error) {
        warnOptional("night re-claim", repeat.error);
        return false;
      }
      claimed = (repeat.data || null) as { id: string } | null;
    }
    if (!claimed) return false;
    try {
      await sendChatMessage(chatId, NIGHT_MESSAGE);
    } catch (sendError) {
      console.warn("WARSTATE night notification skipped", sendError);
    }
    return true;
  } catch (error) {
    warnOptional("night", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Emergency lifecycle
// ---------------------------------------------------------------------------
/**
 * Close any emergency still open when night begins. No losses, no chat
 * message: the night announcement itself already says ЧП pause until 08:00.
 */
async function cancelThreatsForNight(state: DynamicStateRow): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    await supabase
      .from("state_threat_events")
      .update({ status: "failed", resolved_at: new Date().toISOString(), resolution_action: "night_pause" })
      .eq("state_id", state.id)
      .eq("status", "open");
  } catch (error) {
    warnOptional("night threat cancel", error);
  }
}

async function expireDueThreats(state: DynamicStateRow, chatId: number, now: Date): Promise<number> {
  let expired = 0;
  try {
    const supabase = getSupabaseAdmin();
    const nowIso = now.toISOString();
    const { data: due, error } = await supabase
      .from("state_threat_events")
      .select("id,threat_kind")
      .eq("state_id", state.id)
      .eq("status", "open")
      .lte("expires_at", nowIso)
      .order("expires_at", { ascending: true })
      .limit(3);
    if (error) {
      warnOptional("threat due scan", error);
      return 0;
    }
    for (const threat of due || []) {
      const { data: claimed } = await supabase
        .from("state_threat_events")
        .update({ status: "failed", resolved_at: nowIso })
        .eq("id", threat.id)
        .eq("state_id", state.id)
        .eq("status", "open")
        .lte("expires_at", nowIso)
        .select("id")
        .maybeSingle();
      if (!claimed) continue;
      expired += 1;
      try {
        await supabase.rpc("gw_apply_state_loss", { p_state_id: state.id, p_profile: "threat" });
      } catch (lossError) {
        warnOptional("threat loss", lossError);
      }
      const template = threatTemplate(String(threat.threat_kind));
      const text =
        `💥 ГОСУДАРСТВО ПОНЕСЛО УБЫТКИ\n${MESSAGE_DIVIDER}\n` +
        `ЧП «${template?.shortTitle || "ЧРЕЗВЫЧАЙНАЯ СИТУАЦИЯ"}» было проигнорировано — время на реакцию истекло.\n\n` +
        `${template?.failureText || "Безответственность обошлась стране дорого."}\n\n` +
        `Государство «${state.name}» понесло потери и ушло в минус.\n\n` +
        `⚡ Не оставляйте следующие ЧП без внимания — реагируйте кнопками сразу, как только они появляются.`;
      try {
        await sendChatMessage(chatId, text);
      } catch (sendError) {
        console.warn("WARSTATE threat failure notification skipped", sendError);
      }
    }
  } catch (error) {
    warnOptional("threat expiry", error);
  }
  return expired;
}

async function maybeSpawnThreat(state: DynamicStateRow, chatId: number, now: Date, timeZone: string): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin();

    // First sight of this state: arm the scheduler with the next slot and
    // never fire immediately on registration.
    if (!state.next_threat_at) {
      const armedTo = nextThreatSlotAfter(now, timeZone).toISOString();
      const { data: armed } = await supabase
        .from("states")
        .update({ next_threat_at: armedTo })
        .eq("id", state.id)
        .is("next_threat_at", null)
        .select("id")
        .maybeSingle();
      state.next_threat_at = armedTo;
      // Whether we armed it or a concurrent instance did: no spawn this round.
      return false;
    }
    if (new Date(state.next_threat_at).getTime() > now.getTime()) return false;

    // One open emergency at a time. If a previous emergency is somehow still
    // open at slot time, this slot is consumed and the next one is scheduled.
    const { count: openCount, error: openError } = await supabase
      .from("state_threat_events")
      .select("id", { count: "exact", head: true })
      .eq("state_id", state.id)
      .eq("status", "open");
    if (openError) {
      warnOptional("threat open scan", openError);
      return false;
    }

    const firedSlot = state.next_threat_at;
    const nextSlot = nextThreatSlotAfter(now, timeZone).toISOString();

    // Atomic slot claim: exactly one instance spawns this slot's emergency.
    const { data: claimed, error: claimError } = await supabase
      .from("states")
      .update({ next_threat_at: nextSlot })
      .eq("id", state.id)
      .lte("next_threat_at", now.toISOString())
      .select("id")
      .maybeSingle();
    if (claimError) {
      warnOptional("threat slot claim", claimError);
      return false;
    }
    if (!claimed) return false;
    state.next_threat_at = nextSlot;

    if ((openCount || 0) > 0) return false;

    const template = THREAT_TEMPLATES[Math.floor(Math.random() * THREAT_TEMPLATES.length)];
    const expiresAt = new Date(now.getTime() + THREAT_RESPONSE_WINDOW_MS);
    const { data: threat, error: insertError } = await supabase
      .from("state_threat_events")
      .insert({
        state_id: state.id,
        threat_kind: template.kind,
        status: "open",
        threat_slot: firedSlot,
        expires_at: expiresAt.toISOString(),
        loss_profile: "threat",
      })
      .select("id")
      .single();
    if (insertError || !threat) {
      warnOptional("threat insert", insertError || "no row returned");
      return false;
    }

    const minutesLeft = Math.round(THREAT_RESPONSE_WINDOW_MS / 60_000);
    const text =
      `${template.title}\n${MESSAGE_DIVIDER}\n` +
      `${template.body(state.name)}\n\n` +
      `⏱ Время на реакцию: ${minutesLeft} минут.\n` +
      `Нажмите одну из кнопок, пока не поздно:`;
    // Telegram caps callback_data at 64 bytes: "gw:thr:R:" + 36-char uuid +
    // ":" + action always fits with room to spare.
    const keyboard = template.options.map((option) => [
      { text: option.label, callback_data: `gw:thr:R:${threat.id}:${option.action}` },
    ]);
    try {
      await sendChatMessage(chatId, text, keyboard);
    } catch (sendError) {
      // Without the message there are no buttons, so the emergency could never
      // be resolved: roll it back and retry the slot on the next activity.
      console.warn("WARSTATE threat spawn message failed, rolling back", sendError);
      await supabase.from("state_threat_events").delete().eq("id", threat.id).eq("status", "open");
      await supabase.from("states").update({ next_threat_at: now.toISOString() }).eq("id", state.id);
      return false;
    }
    return true;
  } catch (error) {
    warnOptional("threat spawn", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Threat resolution (callback buttons)
// ---------------------------------------------------------------------------
export type ThreatResolution =
  | { outcome: "resolved"; template: ThreatTemplate; option: ThreatOption }
  | { outcome: "closed"; status: string }
  | { outcome: "not_found" }
  | { outcome: "bad_option" };

export async function resolveThreatEvent(params: {
  threatId: string;
  optionAction: string;
  stateId: string;
  playerId: string;
  resolverName: string;
  chatId: number;
}): Promise<ThreatResolution> {
  const supabase = getSupabaseAdmin();
  const { data: threat, error } = await supabase
    .from("state_threat_events")
    .select("id,state_id,threat_kind,status,expires_at")
    .eq("id", params.threatId)
    .maybeSingle();
  if (error) {
    warnOptional("threat load", error);
    return { outcome: "not_found" };
  }
  if (!threat || String(threat.state_id) !== String(params.stateId)) return { outcome: "not_found" };

  const template = threatTemplate(String(threat.threat_kind));
  if (!template) return { outcome: "not_found" };
  const option = template.options.find((item) => item.action === params.optionAction);
  if (!option) return { outcome: "bad_option" };

  const loadedStatus = String(threat.status);
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("state_threat_events")
    .update({
      status: "resolved",
      resolved_at: nowIso,
      resolved_by_player_id: params.playerId,
      resolution_action: option.action,
    })
    .eq("id", threat.id)
    .eq("state_id", params.stateId)
    .eq("status", "open")
    .gt("expires_at", nowIso)
    .select("id")
    .maybeSingle();
  if (claimError) {
    warnOptional("threat resolve claim", claimError);
    return { outcome: "closed", status: loadedStatus };
  }
  if (!claimed) {
    // status was still "open" in our snapshot but the claim failed: another
    // instance just expired it. Report the freshly observed status.
    return { outcome: "closed", status: loadedStatus === "open" ? "failed" : loadedStatus };
  }

  const text =
    `✅ УГРОЗА ОТРАЖЕНА\n${MESSAGE_DIVIDER}\n` +
    `${params.resolverName} отреагировал(а) на ЧП «${template.shortTitle}» — ${option.successText}\n\n` +
    `Государство избежало потерь. Бдительность граждан — главная сила страны!`;
  try {
    await sendChatMessage(params.chatId, text);
  } catch (sendError) {
    console.warn("WARSTATE threat success notification skipped", sendError);
  }
  return { outcome: "resolved", template, option };
}

// ---------------------------------------------------------------------------
// Key-role reminders
// ---------------------------------------------------------------------------
async function maybeNudgeRoles(state: DynamicStateRow, chatId: number, now: Date): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin();
    const lastNudge = state.last_role_nudge_at ? new Date(state.last_role_nudge_at).getTime() : 0;
    if (now.getTime() - lastNudge < ROLE_NUDGE_INTERVAL_MS) return false;

    // Atomic claim of the reminder window (two guarded UPDATEs, no OR filter).
    const cutoff = new Date(now.getTime() - ROLE_NUDGE_INTERVAL_MS).toISOString();
    const baseFilters = (query: any) => query.eq("id", state.id);
    let claimed: { id: string } | null = null;
    const first = await baseFilters(supabase.from("states").update({ last_role_nudge_at: now.toISOString() }))
      .is("last_role_nudge_at", null)
      .select("id")
      .maybeSingle();
    if (first.error) {
      warnOptional("role nudge claim", first.error);
      return false;
    }
    if (first.data) {
      claimed = first.data as { id: string };
    } else {
      const repeat = await baseFilters(supabase.from("states").update({ last_role_nudge_at: now.toISOString() }))
        .lte("last_role_nudge_at", cutoff)
        .select("id")
        .maybeSingle();
      if (repeat.error) {
        warnOptional("role nudge re-claim", repeat.error);
        return false;
      }
      claimed = (repeat.data || null) as { id: string } | null;
    }
    if (!claimed) return false;

    const { data: duties, error: dutiesError } = await supabase
      .from("state_members")
      .select("duty_role")
      .eq("state_id", state.id)
      .not("duty_role", "is", null);
    if (dutiesError) {
      warnOptional("duty scan", dutiesError);
      return false;
    }
    const assigned = new Set((duties || []).map((row: any) => String(row.duty_role)));
    const missing: string[] = [];
    if (!assigned.has("miner")) missing.push("⛏ Шахтёр — без него ресурсы добываются медленнее");
    if (!assigned.has("spy")) missing.push("🕵️ Шпион — без него разведка и шпионаж не работают");
    if (!missing.length) return false;

    const text =
      `⚠️ РОЛИ НЕ РАСПРЕДЕЛЕНЫ\n${MESSAGE_DIVIDER}\n` +
      `В государстве «${state.name}» не заняты ключевые специализации:\n` +
      `${missing.map((line) => `• ${line}`).join("\n")}\n\n` +
      `Назначить специализации может Президент, Заместители или Министр труда:\n` +
      `!роль @игрок шахтер · !роль @игрок шпион`;
    try {
      await sendChatMessage(chatId, text);
    } catch (sendError) {
      console.warn("WARSTATE role nudge notification skipped", sendError);
    }
    return true;
  } catch (error) {
    warnOptional("role nudge", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Election reminders
// ---------------------------------------------------------------------------
/**
 * While a state election is open, nudge the chat every 5 minutes so voters
 * don't forget. This used to be promised in the !выборы message text
 * ("Бот будет напоминать о выборах каждые 5 минут") but nothing actually
 * sent the reminder — this closes that gap using the same atomic-claim
 * pattern as maybeNudgeRoles, keyed on state_elections.last_reminder_at.
 */
async function maybeRemindElection(state: DynamicStateRow, chatId: number, now: Date): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: election, error: electionError } = await supabase
      .from("state_elections")
      .select("id,ends_at,last_reminder_at")
      .eq("state_id", state.id)
      .eq("status", "open")
      .gt("ends_at", now.toISOString())
      .order("ends_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (electionError) {
      warnOptional("election reminder lookup", electionError);
      return false;
    }
    if (!election) return false;

    const lastReminder = election.last_reminder_at ? new Date(election.last_reminder_at).getTime() : 0;
    if (now.getTime() - lastReminder < ELECTION_REMINDER_INTERVAL_MS) return false;

    // Atomic claim of the reminder window (two guarded UPDATEs, no OR filter).
    const cutoff = new Date(now.getTime() - ELECTION_REMINDER_INTERVAL_MS).toISOString();
    const baseFilters = (query: any) => query.eq("id", election.id).eq("status", "open");
    let claimed: { id: string } | null = null;
    const first = await baseFilters(supabase.from("state_elections").update({ last_reminder_at: now.toISOString() }))
      .is("last_reminder_at", null)
      .select("id")
      .maybeSingle();
    if (first.error) {
      warnOptional("election reminder claim", first.error);
      return false;
    }
    if (first.data) {
      claimed = first.data as { id: string };
    } else {
      const repeat = await baseFilters(supabase.from("state_elections").update({ last_reminder_at: now.toISOString() }))
        .lte("last_reminder_at", cutoff)
        .select("id")
        .maybeSingle();
      if (repeat.error) {
        warnOptional("election reminder re-claim", repeat.error);
        return false;
      }
      claimed = (repeat.data || null) as { id: string } | null;
    }
    if (!claimed) return false;

    const minutesLeft = Math.max(0, Math.round((new Date(election.ends_at).getTime() - now.getTime()) / 60_000));
    const text =
      `🗳 ВЫБОРЫ ИДУТ\n${MESSAGE_DIVIDER}\n` +
      `В государстве «${state.name}» ещё не выбран президент.\n` +
      `⏱ Осталось примерно ${minutesLeft} мин.\n\n` +
      `Голосуйте: !голосовать @игрок`;
    try {
      await sendChatMessage(chatId, text);
    } catch (sendError) {
      console.warn("WARSTATE election reminder skipped", sendError);
    }
    return true;
  } catch (error) {
    warnOptional("election reminder", error);
    return false;
  }
}

/**
 * Public snapshot for the !чп command: the currently open emergency (if any)
 * with its remaining response time.
 */
export async function getOpenThreatForChat(chatId: number): Promise<{
  template: ThreatTemplate;
  expiresAt: string;
  minutesLeft: number;
} | null> {
  const state = await loadStateByChat(chatId);
  if (!state) return null;
  const supabase = getSupabaseAdmin();
  const { data: threat, error } = await supabase
    .from("state_threat_events")
    .select("threat_kind,expires_at")
    .eq("state_id", state.id)
    .eq("status", "open")
    .order("expires_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !threat) return null;
  const template = threatTemplate(String(threat.threat_kind));
  if (!template) return null;
  const minutesLeft = Math.max(0, Math.ceil((new Date(threat.expires_at).getTime() - Date.now()) / 60_000));
  return { template, expiresAt: String(threat.expires_at), minutesLeft };
}
