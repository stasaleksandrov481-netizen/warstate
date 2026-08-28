import { getSupabaseAdmin } from "@/lib/supabase/server";
import { adminMiniAppLink, miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { isProjectAdminTelegramId } from "@/lib/config";
import { getProduct } from "@/lib/products";
import { handleGroupCallback, handleGroupTextCommand, processDueGroupVotes } from "@/lib/chat-commands";
import { recordChatActivity, finalizeDueElectionsForChat, registerTelegramState, markStateBotRemoved } from "@/lib/government";
import { bootstrapGame, markTelegramGroupMemberLeft, observeTelegramGroupMember } from "@/lib/game";
import { reconcileStateRuntimeByChatId } from "@/lib/maintenance";
import { initializeDynamicTrackers, reconcileDynamicEventsForChat } from "@/lib/dynamic-events";
import { markSeenOnce } from "@/lib/redis";

export const runtime = "nodejs";
// Command handling can chain several Supabase round-trips plus Telegram API
// calls (bootstrapGame -> getGameSnapshot, etc.). Give it real headroom so a
// slower command doesn't get killed mid-flight and silently black-holed by
// the update-claim lease in migration 017. Vercel clamps this to whatever
// the current plan allows, so it's always safe to request the higher value.
export const maxDuration = 60;

function validWebhookSecret(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  return request.headers.get("x-telegram-bot-api-secret-token") === expected;
}


async function sendFreeportMessage(chatId: number) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `WARSTATE · НЕЙТРАЛЬНАЯ ЗОНА\n────────────\n` +
      `Здесь начинают игроки без государства.\n\n` +
      `Открой Mini App, выбери государство на карте и вступи в его Telegram-чат. После этого нажми «Перейти» — бот проверит членство.`,
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть WARSTATE", url: miniAppLink() }]],
    },
  });
}

async function sendAdminPanelMessage(chatId: number) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `🛠 АДМИН-ПАНЕЛЬ WARSTATE\n────────────\n` +
      `Доступна только создателю проекта.\n\n` +
      `Нажми кнопку ниже, чтобы открыть live-статистику: игроки, государства, битвы, платежи и активность бота.`,
    reply_markup: {
      inline_keyboard: [[{ text: "🛠 Открыть админ-панель", url: adminMiniAppLink() }]],
    },
  });
}

async function sendLaunchMessage(chatId: number, title?: string) {
  const link = miniAppLink(chatId);
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `WARSTATE · ГОСУДАРСТВО ПОДКЛЮЧЕНО\n────────────\n` +
      `${title ? `«${title}»` : "Этот чат"} добавлен на общую карту государств.\n\n` +
      `1. Каждый участник пишет !вступить.\n` +
      `2. Запустите выборы командой !выборы.\n` +
      `3. Для разделов и команд используйте !помощь.\n\n` +
      `ЧП: каждые 5 часов в период 08:00–23:00 по времени государства. На реакцию даётся 10 минут.\n` +
      `Ночной период: 23:00–08:00, новые ЧП не создаются.`,
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть Mini App", url: link }]],
    },
  });
}

function parseInvoicePayload(raw: unknown) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") return null;
    const sku = String(parsed.sku || "");
    const telegramId = Number(parsed.telegram_id);
    const stateId = parsed.state_id ? String(parsed.state_id) : null;
    const product = getProduct(sku);
    if (!product || !Number.isSafeInteger(telegramId) || telegramId <= 0) return null;
    if (product.scope === "state" && !stateId) return null;
    if (product.scope === "player" && stateId) return null;
    return { sku, telegramId, stateId, product };
  } catch {
    return null;
  }
}

async function processSuccessfulPayment(message: any) {
  const payment = message?.successful_payment;
  if (!payment) throw new Error("Telegram sent a payment update without successful_payment payload.");

  const senderId = Number(message?.from?.id);
  const payload = parseInvoicePayload(payment.invoice_payload);
  if (!payload) throw new Error("Invalid successful-payment invoice payload.");
  if (!Number.isSafeInteger(senderId) || senderId <= 0 || payload.telegramId !== senderId) {
    throw new Error("Successful-payment Telegram user does not match invoice payload.");
  }
  if (payment.currency !== "XTR" || Number(payment.total_amount) !== payload.product.stars) {
    throw new Error("Successful-payment amount or currency does not match the product catalog.");
  }

  const chargeId = String(payment.telegram_payment_charge_id || "").trim();
  if (!chargeId) throw new Error("Successful payment has no Telegram charge id.");

  const supabase = getSupabaseAdmin();
  const { data: player, error: playerError } = await supabase.from("players").select("id").eq("telegram_id", senderId).maybeSingle();
  if (playerError) throw playerError;
  if (!player) throw new Error("Paid Telegram account has no WARSTATE player row.");

  const { error: paymentError } = await supabase.from("payments").insert({
    telegram_charge_id: chargeId,
    player_id: player.id,
    state_id: payload.stateId,
    sku: payload.sku,
    stars: payment.total_amount,
    raw_payload: payment,
  });
  // Telegram may redeliver updates. A duplicate payment row is fine: we still
  // continue to the entitlement upsert so a previous partial failure can heal.
  if (paymentError && paymentError.code !== "23505") throw paymentError;

  const { error: entitlementError } = await supabase.from("entitlements").upsert(
    {
      player_id: payload.product.scope === "state" ? null : player.id,
      state_id: payload.stateId,
      sku: payload.sku,
      source_charge_id: chargeId,
    },
    { onConflict: "source_charge_id" },
  );
  if (entitlementError) throw entitlementError;

  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: `✅ ПОКУПКА АКТИВИРОВАНА\n────────────\n${payload.sku} уже доступен в WARSTATE.`,
  });
}

export async function POST(request: Request) {
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) return new Response("TELEGRAM_WEBHOOK_SECRET is not configured", { status: 500 });
  if (!validWebhookSecret(request)) return new Response("forbidden", { status: 403 });
  let update: any;
  try {
    update = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  try {
    console.info("WARSTATE_RUNTIME=5.0-continent");
    // Pre-checkout and successful-payment updates use their own Telegram/charge
    // idempotency flow because a failed payment write must be allowed to retry.
    // All ordinary commands, callbacks and membership events are claimed once
    // globally in PostgreSQL before any game action is executed.
    if (!update.pre_checkout_query && !update.message?.successful_payment && Number.isSafeInteger(Number(update.update_id))) {
      try {
        const supabase = getSupabaseAdmin();
        const { data: claimed, error: claimError } = await supabase.rpc("gw_claim_telegram_update", {
          p_update_id: Number(update.update_id),
          p_lease_seconds: 45,
        });
        // Migration 015 may be missing during a rolling deploy. In that one case
        // fail open so group commands still work. Real database/transport errors
        // must surface as 500, allowing Telegram to redeliver instead of losing the update.
        if (claimError?.code === "PGRST202") {
          console.warn("Telegram update receipt RPC is unavailable; processing without receipt claim");
        } else if (claimError) {
          throw claimError;
        } else if (claimed === false) {
          return Response.json({ ok: true, duplicate: true });
        }
      } catch (claimError) {
        console.error("Telegram update receipt claim failed", claimError);
        return Response.json({ ok: false, retry: true }, { status: 500 });
      }
    }

    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      const payload = parseInvoicePayload(query.invoice_payload);
      const valid = Boolean(
        payload
        && payload.telegramId === Number(query.from?.id)
        && query.currency === "XTR"
        && Number(query.total_amount) === payload.product.stars
      );
      await telegramApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: query.id,
        ok: valid,
        ...(valid ? {} : { error_message: "Платёжные данные устарели. Откройте магазин ещё раз." }),
      });
      return Response.json({ ok: true });
    }

    if (update.message?.successful_payment) {
      try {
        await processSuccessfulPayment(update.message);
        return Response.json({ ok: true });
      } catch (error) {
        // Payment/entitlement writes are idempotent by Telegram charge id. Returning
        // 500 here lets Telegram retry instead of silently losing a paid entitlement.
        console.error("Telegram successful_payment processing failed", error);
        return Response.json({ ok: false }, { status: 500 });
      }
    }

    if (update.callback_query) {
      if (await handleGroupCallback(update.callback_query)) return Response.json({ ok: true });
    }

    const membership = update.my_chat_member;
    if (membership?.chat?.id && ["group", "supergroup"].includes(membership.chat.type)) {
      const status = membership.new_chat_member?.status;
      if (["member", "administrator"].includes(status)) {
        await registerTelegramState(Number(membership.chat.id));
        await sendLaunchMessage(membership.chat.id, membership.chat.title);
        // Arm the dynamic-events engine right at add-time: the 30-minute
        // President vacancy countdown and the daytime emergency scheduler
        // start together with the welcome message.
        await initializeDynamicTrackers(Number(membership.chat.id)).catch((error) =>
          console.warn("WARSTATE dynamic tracker initialization skipped", error));
      } else if (["left", "kicked"].includes(status)) {
        // Bot was removed from the group: hide the state from the map,
        // leaderboards, search and diplomacy everywhere else immediately.
        // Nothing is deleted — re-adding the bot restores it via
        // registerTelegramState() above.
        await markStateBotRemoved(Number(membership.chat.id)).catch((error) =>
          console.warn("WARSTATE bot-removed state hide skipped", error));
      }
      return Response.json({ ok: true });
    }

    const memberUpdate = update.chat_member;
    if (memberUpdate?.chat?.id && ["group", "supergroup"].includes(memberUpdate.chat.type)) {
      const member = memberUpdate.new_chat_member?.user;
      const status = String(memberUpdate.new_chat_member?.status || "");
      if (member?.id && !member?.is_bot) {
        if (["member", "administrator", "creator", "restricted"].includes(status)) {
          await observeTelegramGroupMember({
            id: Number(member.id),
            first_name: String(member.first_name || "Игрок"),
            last_name: member.last_name ? String(member.last_name) : undefined,
            username: member.username ? String(member.username) : undefined,
          }, Number(memberUpdate.chat.id)).catch((error) => console.warn("WARSTATE chat_member observation skipped", error));
        } else if (["left", "kicked"].includes(status)) {
          await markTelegramGroupMemberLeft(Number(memberUpdate.chat.id), Number(member.id)).catch((error) => console.warn("WARSTATE chat_member leave mark skipped", error));
        }
      }
      return Response.json({ ok: true });
    }

    const message = update.message;
    if (message?.chat?.id && message.chat.type === "private") {
      const text = String(message.text || "").trim();
      if (text === "/admin") {
        // Silently ignored for everyone except the project admin(s) configured via
        // WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS / WARSTATE_SUPERADMIN_TELEGRAM_ID, so
        // the command's existence isn't revealed to ordinary players.
        if (isProjectAdminTelegramId(message.from?.id)) {
          await sendAdminPanelMessage(message.chat.id);
        }
        return Response.json({ ok: true });
      }
      if (text.startsWith("/start") || text === "/freeport") {
        await sendFreeportMessage(message.chat.id);
      }
      return Response.json({ ok: true });
    }

    if (message?.chat?.id && ["group", "supergroup"].includes(message.chat.type)) {
      // Telegram does not expose a complete historical member list to bots.
      // We therefore enrol every newly joined human immediately, and any existing
      // member is enrolled on their first message/command or via !вступить.
      if (Array.isArray(message.new_chat_members)) {
        for (const member of message.new_chat_members) {
          if (!member?.id || member?.is_bot) continue;
          await observeTelegramGroupMember({
            id: Number(member.id),
            first_name: String(member.first_name || "Игрок"),
            last_name: member.last_name ? String(member.last_name) : undefined,
            username: member.username ? String(member.username) : undefined,
          }, Number(message.chat.id)).catch((error) => console.warn("WARSTATE new member observation skipped", error));
        }
      }

      // Keep the sender known to WARSTATE without blindly moving citizens between
      // states. This makes reply-based government commands work even when the user
      // has never opened Mini App, while preserving the one-home-state invariant.
      // This does ~5 sequential DB round trips, so on a busy chat it is throttled
      // to once per user per window instead of running on literally every message;
      // bootstrapGame() already does its own player/state upsert for real commands,
      // so this is only a backstop for users who never trigger a command directly.
      // It also runs concurrently with the command dispatch below instead of
      // blocking it, so a slow command chat doesn't have to wait on it twice.
      let observePromise: Promise<unknown> = Promise.resolve();
      if (message.from?.id && !message.from?.is_bot) {
        const senderId = Number(message.from.id);
        const chatIdForSeen = Number(message.chat.id);
        observePromise = markSeenOnce(`observe:${chatIdForSeen}:${senderId}`, 180)
          .then((shouldObserve) => {
            if (!shouldObserve) return undefined;
            return observeTelegramGroupMember({
              id: senderId,
              first_name: String(message.from.first_name || "Игрок"),
              last_name: message.from.last_name ? String(message.from.last_name) : undefined,
              username: message.from.username ? String(message.from.username) : undefined,
            }, chatIdForSeen);
          })
          .catch((error) => console.warn("WARSTATE sender observation skipped", error));
      }

      // Commands are the critical path. Never make a !command wait for optional
      // world maintenance, vote settlement or chat-farm bookkeeping.
      const isCommand = await handleGroupTextCommand(message);
      await observePromise;
      if (isCommand) return Response.json({ ok: true });
      // A leading ! belongs to WARSTATE only when it exactly matches a registered
      // command. Unknown bang-commands are a hard no-op so we never answer typos
      // or commands intended for another bot in the same group.
      if (String(message.text || "").trim().startsWith("!")) {
        return Response.json({ ok: true, ignored: "unknown_bang_command" });
      }
      const text = String(message.text || "").split("@")[0].trim();
      if (["/groupwars", "/gw", "/war"].includes(text)) {
        await registerTelegramState(Number(message.chat.id));
        await sendLaunchMessage(message.chat.id, message.chat.title);
        return Response.json({ ok: true });
      }

      // Every ordinary group message can award +2 XP and +1 state contribution,
      // but SQL enforces a strict one-minute cooldown per player. If this is a
      // legacy chat/player, self-heal registration/citizenship once and retry.
      if (message.from?.id && !message.from?.is_bot && !String(message.text || "").trim().startsWith("!")) {
        try {
          const first = await recordChatActivity(Number(message.chat.id), Number(message.from.id));
          if (!first?.applied && ["state_missing", "player_missing", "not_member"].includes(String(first?.reason || ""))) {
            const observed = await observeTelegramGroupMember({
              id: Number(message.from.id),
              first_name: String(message.from.first_name || "Игрок"),
              last_name: message.from.last_name ? String(message.from.last_name) : undefined,
              username: message.from.username ? String(message.from.username) : undefined,
            }, Number(message.chat.id));
            if (observed.enrolled) await recordChatActivity(Number(message.chat.id), Number(message.from.id));
          }
          // Resource bundles are credited in SQL, but ordinary chat activity is
          // intentionally silent. Busy state chats should not receive a bot message
          // every ten human messages.
        } catch (activityError) {
          console.warn("WARSTATE chat activity reward skipped", activityError);
        }
      }

      // Vote settlement, battle/election/building runtime reconciliation and
      // the dynamic chat-events engine (anarchy timer, night mode, ЧП) touch
      // disjoint tables and don't depend on each other's result, so run them
      // together instead of paying for sequential round trips per message.
      await Promise.all([
        processDueGroupVotes(Number(message.chat.id)).catch((voteError) => {
          console.warn("WARSTATE vote settlement skipped", voteError);
        }),
        finalizeDueElectionsForChat(Number(message.chat.id)).catch((electionError) => {
          console.warn("WARSTATE election settlement skipped", electionError);
        }),
        reconcileStateRuntimeByChatId(Number(message.chat.id)).catch((runtimeError) => {
          console.warn("WARSTATE event-driven maintenance skipped", runtimeError);
        }),
        reconcileDynamicEventsForChat(Number(message.chat.id)).catch((dynamicError) => {
          console.warn("WARSTATE dynamic events reconciliation skipped", dynamicError);
        }),
      ]);

    }
  } catch (error) {
    console.error("Telegram webhook error", error);
    // Do not acknowledge a failed update as successful: Telegram can retry it.
    return Response.json({ ok: false, retry: true }, { status: 500 });
  }

  return Response.json({ ok: true });
}
