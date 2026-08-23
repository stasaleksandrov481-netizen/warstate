import crypto from "node:crypto";
import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { telegramApi } from "@/lib/telegram-bot";

export const runtime = "nodejs";

const PRODUCTS: Record<string, { title: string; description: string; stars: number; scope: "player" | "state" }> = {
  season_pass: { title: "Season Pass", description: "Сезонная косметическая ветка GROUP WARS", stars: 250, scope: "player" },
  state_banner: { title: "State Banner Pack", description: "Премиальный набор оформления государства", stars: 125, scope: "state" },
  city_noir: { title: "Noir City Skin", description: "Тёмная тема 2.5D-города для государства", stars: 300, scope: "state" },
  profile_frame: { title: "Veteran Profile Frame", description: "Редкая рамка профиля игрока", stars: 75, scope: "player" },
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    const sku = String(body.sku || "");
    const product = PRODUCTS[sku];
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
