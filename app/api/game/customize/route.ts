import { authorizeStateAction, jsonError } from "@/lib/request-auth";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getGameSnapshot } from "@/lib/game";

export const runtime = "nodejs";
const EMBLEMS = new Set(["◆","◈","⬡","⚑","✦","★","♜","☄"]);
const THEMES = new Set(["violet","cyan","ember","emerald","steel"]);
const HEX = /^#[0-9a-fA-F]{6}$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const stateId = String(body.stateId || "");
    if (!stateId) throw new Error("stateId is required");
    const auth = await authorizeStateAction(request, stateId, { verifyTelegramMembership: true });
    if (auth.state.is_freeport) throw new Error("Freeport — нейтральная территория и не меняет оформление игроками.");
    if (!["president","minister"].includes(auth.member.role)) throw new Error("Оформление меняют президент или министр.");

    const patch: Record<string, string> = {};
    if (body.motto !== undefined) patch.motto = String(body.motto).trim().slice(0, 80) || "Сила в единстве";
    if (body.emblem !== undefined) {
      const emblem = String(body.emblem);
      if (!EMBLEMS.has(emblem)) throw new Error("Неизвестная эмблема.");
      patch.emblem = emblem;
    }
    if (body.theme !== undefined) {
      const theme = String(body.theme);
      if (!THEMES.has(theme)) throw new Error("Неизвестная тема.");
      patch.theme = theme;
    }
    if (body.color !== undefined) {
      const color = String(body.color);
      if (!HEX.test(color)) throw new Error("Цвет должен быть в формате #RRGGBB.");
      patch.color = color.toLowerCase();
    }
    if (!Object.keys(patch).length) throw new Error("Нечего менять.");
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("states").update(patch).eq("id", stateId);
    if (error) throw error;
    return Response.json(await getGameSnapshot(auth.player.id, stateId, auth.session.user.id, auth.member.role));
  } catch (error) {
    return jsonError(error);
  }
}
