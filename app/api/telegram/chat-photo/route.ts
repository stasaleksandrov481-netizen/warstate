import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getTelegramFile, telegramFileUrl } from "@/lib/telegram-bot";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const stateId = url.searchParams.get("stateId");
    if (!stateId) return new Response("stateId is required", { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data: state, error } = await supabase
      .from("states")
      .select("chat_avatar_file_id")
      .eq("id", stateId)
      .single();
    if (error || !state?.chat_avatar_file_id) return new Response(null, { status: 404 });

    const file = await getTelegramFile(state.chat_avatar_file_id);
    if (!file.file_path) return new Response(null, { status: 404 });

    const upstream = await fetch(telegramFileUrl(file.file_path), { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!upstream.ok) return new Response(null, { status: 502 });
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    return new Response(upstream.body, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("Telegram chat photo proxy failed", error);
    return new Response(null, { status: 502 });
  }
}
