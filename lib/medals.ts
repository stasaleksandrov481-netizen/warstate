import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { MedalView } from "@/lib/types";

function medalRow(row: any): MedalView {
  const by = row.awarded_by_username ? `@${String(row.awarded_by_username).replace(/^@/, "")}` : `ID ${String(row.awarded_by_telegram_id || "—")}`;
  return {
    id: String(row.id),
    icon: String(row.icon || "◆"),
    title: String(row.title || "Награда"),
    description: String(row.description || ""),
    awardedAt: String(row.awarded_at),
    awardedBy: by,
  };
}

export async function getPlayerMedals(playerId: string, limit = 24): Promise<MedalView[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("player_medals")
    .select("id,icon,title,description,awarded_at,awarded_by_telegram_id,awarded_by_username")
    .eq("player_id", playerId)
    .order("awarded_at", { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));
  if (error) {
    if (["42P01", "PGRST205"].includes(String((error as any)?.code || ""))) return [];
    throw error;
  }
  return (data || []).map(medalRow);
}

export async function getStateMedals(stateId: string, limit = 24): Promise<MedalView[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_medals")
    .select("id,icon,title,description,awarded_at,awarded_by_telegram_id,awarded_by_username")
    .eq("state_id", stateId)
    .order("awarded_at", { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));
  if (error) {
    if (["42P01", "PGRST205"].includes(String((error as any)?.code || ""))) return [];
    throw error;
  }
  return (data || []).map(medalRow);
}
