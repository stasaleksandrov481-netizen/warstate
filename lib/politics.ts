import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recordWorldEvent } from "@/lib/diplomacy";
import type { ElectionView, SeasonView, StateBadgeView } from "@/lib/types";
import { requireData } from "@/lib/invariants";

export async function getActiveSeason(): Promise<SeasonView | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("seasons")
    .select("id,name,number,starts_at,ends_at,active")
    .eq("active", true)
    .order("number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    number: data.number,
    startsAt: data.starts_at,
    endsAt: data.ends_at,
    active: data.active,
  };
}

export async function getStateBadges(stateId: string, limit = 12): Promise<StateBadgeView[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("state_badges")
    .select("id,badge_key,title,description,icon,earned_at")
    .eq("state_id", stateId)
    .order("earned_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((badge: any) => ({
    id: badge.id,
    key: badge.badge_key,
    title: badge.title,
    description: badge.description,
    icon: badge.icon,
    earnedAt: badge.earned_at,
  }));
}

export async function ensureMilestoneBadges(stateId: string, seasonId: string | null, rating: number, wins: number, bestWinStreak: number) {
  const supabase = getSupabaseAdmin();
  const badges: Array<{ key: string; title: string; description: string; icon: string }> = [];
  if (wins >= 1) badges.push({ key: "island_first_win", title: "Первый рейд", description: "Выиграть первую островную войну", icon: "⚔" });
  if (wins >= 5) badges.push({ key: "island_wins_5", title: "Морские волки", description: "Победить в 5 островных войнах", icon: "☠" });
  if (wins >= 20) badges.push({ key: "island_wins_20", title: "Штормовой фронт", description: "Победить в 20 островных войнах", icon: "♜" });
  if (rating >= 1500) badges.push({ key: "rating_1500", title: "На мировой сцене", description: "Достичь рейтинга 1500", icon: "★" });
  if (bestWinStreak >= 3) badges.push({ key: "streak_3", title: "На волне", description: "Выиграть 3 войны подряд", icon: "≈" });
  if (bestWinStreak >= 7) badges.push({ key: "streak_7", title: "Непотопляемые", description: "Выиграть 7 войн подряд", icon: "◆" });
  if (!badges.length) return;
  for (const badge of badges) {
    const { error } = await supabase.from("state_badges").upsert({
      state_id: stateId,
      season_id: seasonId,
      badge_key: badge.key,
      title: badge.title,
      description: badge.description,
      icon: badge.icon,
    }, { onConflict: "state_id,badge_key,season_id", ignoreDuplicates: true });
    if (error) throw error;
  }
}

export async function getElection(stateId: string, playerId: string): Promise<ElectionView | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_get_election", { p_state_id: stateId, p_player_id: playerId });
  if (error) throw error;
  return data ? data as ElectionView : null;
}

export async function openElection(stateId: string, playerId: string) {
  const supabase = getSupabaseAdmin();
  const season = await getActiveSeason();
  const { data, error } = await supabase.from("state_elections").insert({
    state_id: stateId,
    season_id: season?.id || null,
    ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_by_player_id: playerId,
  }).select("id").single();
  if (error) {
    if (error.code === "23505") throw new Error("Выборы уже идут.");
    throw error;
  }
  const election = requireData(data, "Не удалось открыть выборы.");
  const { error: candidateError } = await supabase
    .from("election_candidates")
    .insert({ election_id: election.id, player_id: playerId, statement: "Продолжить курс государства." });
  if (candidateError) throw candidateError;
  await recordWorldEvent({ eventType: "election_opened", title: "Начались выборы", body: "В государстве открыто голосование за президента.", actorStateId: stateId });
  return election.id;
}

export async function nominateCandidate(electionId: string, playerId: string, statement: string) {
  const supabase = getSupabaseAdmin();
  const { data: election, error: electionError } = await supabase.from("state_elections").select("state_id,status,ends_at").eq("id", electionId).single();
  if (electionError) throw electionError;
  const electionRow = requireData(election, "Выборы не найдены.");
  if (electionRow.status !== "open" || new Date(electionRow.ends_at).getTime() <= Date.now()) throw new Error("Выборы уже закрыты.");
  const { data: member, error: memberError } = await supabase.from("state_members").select("id").eq("state_id", electionRow.state_id).eq("player_id", playerId).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new Error("Только граждане могут выдвигаться.");
  const { error } = await supabase.from("election_candidates").upsert({
    election_id: electionId,
    player_id: playerId,
    statement: statement.trim().slice(0, 120),
  }, { onConflict: "election_id,player_id" });
  if (error) throw error;
}

export async function castVote(electionId: string, voterPlayerId: string, candidateId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("gw_cast_vote", {
    p_election_id: electionId,
    p_voter_player_id: voterPlayerId,
    p_candidate_id: candidateId,
  });
  if (error) throw error;
}

export async function finalizeElection(electionId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_finalize_election", { p_election_id: electionId });
  if (error) throw error;
  if (data?.applied && data?.winnerPlayerId) {
    const { data: election, error: electionError } = await supabase.from("state_elections").select("state_id").eq("id", electionId).single();
    if (electionError) throw electionError;
    const { data: winner, error: winnerError } = await supabase.from("players").select("display_name").eq("id", data.winnerPlayerId).single();
    if (winnerError) throw winnerError;
    if (election) await recordWorldEvent({ eventType: "election_resolved", title: "Новый президент", body: `${winner?.display_name || "Кандидат"} победил на выборах.`, actorStateId: election.state_id });
  }
  return data;
}
