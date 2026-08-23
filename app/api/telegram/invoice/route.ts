import crypto from "node:crypto";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { telegramApi } from "@/lib/telegram-bot";
import { getProduct } from "@/lib/products";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const sku = String(body.sku || "");
    const product = getProduct(sku);
    if (!stateId || !product) throw new Error("Invalid purchase request");
    const { session } = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });

    const payload = JSON.stringify({
      v: 1,
      sku,
      telegram_id: session.user.id,
      state_id: product.scope === "state" ? stateId : null,
      nonce: crypto.randomUUID(),
    });

    const link = await telegramApi<string>("createInvoiceLink", {
      title: product.title,
      description: product.description,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: product.title, amount: product.stars }],
    });

    return Response.json({ link });
  } catch (error) {
    return jsonError(error);
  }
}
