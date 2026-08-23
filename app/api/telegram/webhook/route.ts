import { getSupabaseAdmin } from "@/lib/supabase/server";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";

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
      `${title ? `Группа «${title}»` : "Этот чат"} может стать государством. ` +
      `Участники будут развивать общий 2.5D-город, захватывать территории и воевать с другими Telegram-группами.\n\n` +
      `Первый запуск должен сделать администратор группы.`,
    reply_markup: {
      inline_keyboard: [[{ text: "🏙 Войти в GROUP WARS", url: link }]],
    },
  });
}

async function processSuccessfulPayment(message: any) {
  const payment = message.successful_payment;
  if (!payment) return;
  let payload: any;
  try {
    payload = JSON.parse(payment.invoice_payload);
  } catch {
    return;
  }
  if (!payload?.sku || Number(payload.telegram_id) !== Number(message.from?.id)) return;

  const supabase = getSupabaseAdmin();
  const chargeId = payment.telegram_payment_charge_id;
  const { data: existing } = await supabase.from("payments").select("id").eq("telegram_charge_id", chargeId).maybeSingle();
  if (existing) return;

  const { data: player } = await supabase.from("players").select("id").eq("telegram_id", message.from.id).single();
  if (!player) return;

  await supabase.from("payments").insert({
    telegram_charge_id: chargeId,
    player_id: player.id,
    state_id: payload.state_id || null,
    sku: payload.sku,
    stars: payment.total_amount,
    raw_payload: payment,
  });

  await supabase.from("entitlements").upsert(
    {
      player_id: payload.state_id ? null : player.id,
      state_id: payload.state_id || null,
      sku: payload.sku,
      source_charge_id: chargeId,
    },
    { onConflict: "source_charge_id" },
  );

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
      await telegramApi("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
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
