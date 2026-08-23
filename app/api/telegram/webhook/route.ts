import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { getProduct } from "@/lib/products";

export const runtime = "nodejs";

function validWebhookSecret(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return request.headers.get("x-telegram-bot-api-secret-token") === expected;
}

async function sendLaunchMessage(chatId: number, title?: string) {
  const link = miniAppLink(chatId);
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text:
      `⚔️ GROUP WARS\n\n` +
      `${title ? `Группа «${title}»` : "Этот чат"} может стать островом-государством. ` +
      `Размер острова растёт вместе с сообществом, а рейтинг меняется в морских войнах против других Telegram-групп.\n\n` +
      `Первый запуск должен сделать администратор группы.`,
    reply_markup: {
      inline_keyboard: [[{ text: "🌊 Открыть остров", url: link }]],
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
  const payment = message.successful_payment;
  if (!payment) return;
  const payload = parseInvoicePayload(payment.invoice_payload);
  if (!payload || payload.telegramId !== Number(message.from?.id)) return;
  if (payment.currency !== "XTR" || Number(payment.total_amount) !== payload.product.stars) return;

  const supabase = getSupabaseAdmin();
  const chargeId = payment.telegram_payment_charge_id;
  const { data: player, error: playerError } = await supabase.from("players").select("id").eq("telegram_id", message.from.id).maybeSingle();
  if (playerError) throw playerError;
  if (!player) return;

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
    text: `✅ Покупка активирована: ${payload.sku}`,
  });
}

export async function POST(request: Request) {
  if (!validWebhookSecret(request)) return new Response("forbidden", { status: 403 });
  const update = await request.json();

  try {
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
      await processSuccessfulPayment(update.message);
      return Response.json({ ok: true });
    }

    const membership = update.my_chat_member;
    if (membership?.chat?.id && ["group", "supergroup"].includes(membership.chat.type)) {
      const status = membership.new_chat_member?.status;
      if (["member", "administrator"].includes(status)) {
        await sendLaunchMessage(membership.chat.id, membership.chat.title);
      }
      return Response.json({ ok: true });
    }

    const message = update.message;
    if (message?.chat?.id && ["group", "supergroup"].includes(message.chat.type)) {
      const text = String(message.text || "").split("@")[0].trim();
      if (["/groupwars", "/gw", "/war"].includes(text)) {
        await sendLaunchMessage(message.chat.id, message.chat.title);
      }
    }
  } catch (error) {
    console.error("Telegram webhook error", error);
  }

  return Response.json({ ok: true });
}
