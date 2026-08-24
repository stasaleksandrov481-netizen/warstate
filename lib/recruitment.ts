import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createStateJoinLink } from "@/lib/telegram-bot";
import type {
  FreeAgentView,
  RecruitmentHubView,
  RecruitmentPostView,
  RecruitmentRequestView,
} from "@/lib/types";

const LEADERS = new Set(["president", "minister", "deputy", "curator"]);

function clampText(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}

function clampInteger(value: unknown, min: number, max: number, defaultValue: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

async function updatePendingRequest(requestId: string, patch: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("recruitment_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Заявка уже была обработана. Обновите экран набора.");
}

async function stateMap(ids: string[]) {
  const supabase = getSupabaseAdmin();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, any>();
  const { data, error } = await supabase
    .from("states")
    .select("id,name,color,rating,telegram_member_count,telegram_chat_id,is_freeport")
    .in("id", unique);
  if (error) throw error;
  return new Map((data || []).map((row: any) => [String(row.id), row]));
}

async function playerMap(ids: string[]) {
  const supabase = getSupabaseAdmin();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, any>();
  const { data, error } = await supabase
    .from("players")
    .select("id,display_name,username,level,xp")
    .in("id", unique);
  if (error) throw error;
  return new Map((data || []).map((row: any) => [String(row.id), row]));
}

function postView(row: any, state: any): RecruitmentPostView {
  return {
    stateId: String(row.state_id),
    stateName: String(state?.name || "Государство"),
    stateColor: String(state?.color || "#5d8d68"),
    memberCount: Math.max(1, Number(state?.telegram_member_count || 1)),
    rating: Math.max(0, Number(state?.rating || 1000)),
    headline: String(row.headline || "Набор открыт"),
    message: String(row.message || ""),
    minLevel: Math.max(1, Number(row.min_level || 1)),
  };
}

function requestView(row: any, state: any, player: any): RecruitmentRequestView {
  return {
    id: String(row.id),
    stateId: String(row.state_id),
    stateName: String(state?.name || "Государство"),
    stateColor: String(state?.color || "#5d8d68"),
    playerId: String(row.player_id),
    playerName: String(player?.display_name || "Игрок"),
    playerLevel: Math.max(1, Number(player?.level || 1)),
    playerXp: Math.max(0, Number(player?.xp || 0)),
    kind: row.kind === "offer" ? "offer" : "application",
    status: ["pending", "accepted", "rejected", "withdrawn"].includes(row.status) ? row.status : "pending",
    message: String(row.message || ""),
    inviteLink: row.invite_link || null,
    updatedAt: String(row.updated_at || row.created_at || new Date().toISOString()),
  };
}

export async function getRecruitmentHub(
  playerId: string,
  stateId: string,
  isFreeport: boolean,
  role: string,
): Promise<RecruitmentHubView> {
  const supabase = getSupabaseAdmin();
  const leader = LEADERS.has(role) && !isFreeport;
  const [postsRes, myRes] = await Promise.all([
    supabase.from("recruitment_posts").select("*").eq("is_open", true).order("updated_at", { ascending: false }).limit(32),
    supabase.from("recruitment_requests").select("*").eq("player_id", playerId).order("updated_at", { ascending: false }).limit(24),
  ]);
  if (postsRes.error) throw postsRes.error;
  if (myRes.error) throw myRes.error;

  let incomingRows: any[] = [];
  let currentPost: any = null;
  if (leader) {
    const [incomingRes, currentPostRes] = await Promise.all([
      supabase.from("recruitment_requests").select("*").eq("state_id", stateId).eq("status", "pending").order("updated_at", { ascending: false }).limit(32),
      supabase.from("recruitment_posts").select("*").eq("state_id", stateId).maybeSingle(),
    ]);
    if (incomingRes.error) throw incomingRes.error;
    if (currentPostRes.error) throw currentPostRes.error;
    incomingRows = incomingRes.data || [];
    currentPost = currentPostRes.data || null;
  }

  const allRequests = [...(myRes.data || []), ...incomingRows] as any[];
  const stateIds = [
    ...(postsRes.data || []).map((row: any) => String(row.state_id)),
    ...allRequests.map((row) => String(row.state_id)),
    stateId,
  ];
  const playerIds = allRequests.map((row) => String(row.player_id));
  const [states, players] = await Promise.all([stateMap(stateIds), playerMap(playerIds)]);

  const listings = (postsRes.data || [])
    .filter((row: any) => String(row.state_id) !== stateId)
    .map((row: any) => postView(row, states.get(String(row.state_id))))
    .filter((row: any) => row.stateName !== "Freeport");

  const myRequests = (myRes.data || []).map((row: any) => requestView(
    row,
    states.get(String(row.state_id)),
    players.get(String(row.player_id)),
  ));
  const incoming = incomingRows.map((row: any) => requestView(
    row,
    states.get(String(row.state_id)),
    players.get(String(row.player_id)),
  ));

  let freeAgents: FreeAgentView[] = [];
  if (leader) {
    const { data: freeport, error: freeportError } = await supabase.from("states").select("id").eq("is_freeport", true).maybeSingle();
    if (freeportError) throw freeportError;
    if (freeport?.id) {
      const { data: members, error: membersError } = await supabase
        .from("state_members")
        .select("player_id,contribution")
        .eq("state_id", freeport.id)
        .order("contribution", { ascending: false })
        .limit(30);
      if (membersError) throw membersError;
      const memberRows = members || [];
      const pmap = await playerMap(memberRows.map((row: any) => String(row.player_id)));
      freeAgents = memberRows
        .map((row: any) => {
          const player = pmap.get(String(row.player_id));
          if (!player) return null;
          return {
            playerId: String(player.id),
            displayName: String(player.display_name),
            username: player.username || null,
            level: Math.max(1, Number(player.level || 1)),
            xp: Math.max(0, Number(player.xp || 0)),
            contribution: Math.max(0, Number(row.contribution || 0)),
          } satisfies FreeAgentView;
        })
        .filter(Boolean) as FreeAgentView[];
      freeAgents.sort((a, b) => b.level - a.level || b.xp - a.xp || b.contribution - a.contribution);
    }
  }

  return {
    post: currentPost ? postView(currentPost, states.get(stateId)) : null,
    listings,
    myRequests,
    incoming,
    freeAgents,
  };
}

async function inviteForState(stateId: string, playerName: string) {
  const supabase = getSupabaseAdmin();
  const { data: state, error } = await supabase
    .from("states")
    .select("telegram_chat_id,name,is_freeport")
    .eq("id", stateId)
    .single();
  if (error || !state) throw new Error("Государство не найдено.");
  if (state.is_freeport || !state.telegram_chat_id) throw new Error("В Freeport приглашение не требуется.");
  const inviteLink = await createStateJoinLink(Number(state.telegram_chat_id), `WARSTATE · ${playerName}`);
  if (!inviteLink) throw new Error("Не удалось создать ссылку-приглашение. Проверьте права бота на приглашение участников.");
  return inviteLink;
}

export async function recruitmentAction(params: {
  playerId: string;
  currentStateId: string;
  currentStateIsFreeport: boolean;
  role: string;
  action: string;
  targetStateId?: string;
  targetPlayerId?: string;
  requestId?: string;
  message?: string;
  headline?: string;
  minLevel?: number;
}) {
  const supabase = getSupabaseAdmin();
  const leader = LEADERS.has(params.role) && !params.currentStateIsFreeport;

  if (params.action === "set_post") {
    if (!leader) throw new Error("Только командование государства управляет набором.");
    const headline = clampText(params.headline, 48) || "Набор открыт";
    const message = clampText(params.message, 220);
    const minLevel = clampInteger(params.minLevel, 1, 1000, 1);
    const { error } = await supabase.from("recruitment_posts").upsert({
      state_id: params.currentStateId,
      is_open: true,
      headline,
      message,
      min_level: minLevel,
      updated_at: new Date().toISOString(),
    }, { onConflict: "state_id" });
    if (error) throw error;
    return;
  }

  if (params.action === "close_post") {
    if (!leader) throw new Error("Только командование государства управляет набором.");
    const { error } = await supabase.from("recruitment_posts").update({ is_open: false, updated_at: new Date().toISOString() }).eq("state_id", params.currentStateId);
    if (error) throw error;
    return;
  }

  if (params.action === "apply") {
    if (!params.currentStateIsFreeport) throw new Error("Подавать заявки могут свободные игроки Freeport.");
    const targetStateId = String(params.targetStateId || "");
    if (!targetStateId) throw new Error("Не выбрано государство.");
    const { data: post, error: postError } = await supabase.from("recruitment_posts").select("min_level,is_open").eq("state_id", targetStateId).maybeSingle();
    if (postError) throw postError;
    if (!post?.is_open) throw new Error("Это государство сейчас не ведёт набор.");
    const { data: player, error: playerError } = await supabase.from("players").select("level").eq("id", params.playerId).single();
    if (playerError || !player) throw new Error("Игрок не найден.");
    if (player.level < post.min_level) throw new Error(`Для заявки нужен уровень ${post.min_level}.`);
    const { error } = await supabase.from("recruitment_requests").upsert({
      state_id: targetStateId,
      player_id: params.playerId,
      kind: "application",
      status: "pending",
      message: clampText(params.message, 180),
      invite_link: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "state_id,player_id,kind" });
    if (error) throw error;
    return;
  }

  if (params.action === "offer") {
    if (!leader) throw new Error("Предложения игрокам отправляет командование.");
    const targetPlayerId = String(params.targetPlayerId || "");
    if (!targetPlayerId) throw new Error("Игрок не выбран.");
    const { data: freeport, error: freeportError } = await supabase.from("states").select("id").eq("is_freeport", true).single();
    if (freeportError || !freeport) throw new Error("Freeport не найден.");
    const { data: member, error: memberError } = await supabase.from("state_members").select("id").eq("state_id", freeport.id).eq("player_id", targetPlayerId).maybeSingle();
    if (memberError) throw memberError;
    if (!member) throw new Error("Игрок уже не находится в Freeport.");
    const { error } = await supabase.from("recruitment_requests").upsert({
      state_id: params.currentStateId,
      player_id: targetPlayerId,
      kind: "offer",
      status: "pending",
      message: clampText(params.message, 180),
      invite_link: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "state_id,player_id,kind" });
    if (error) throw error;
    return;
  }

  const requestId = String(params.requestId || "");
  if (!requestId) throw new Error("Заявка не найдена.");
  const { data: request, error: requestError } = await supabase.from("recruitment_requests").select("*").eq("id", requestId).single();
  if (requestError || !request) throw new Error("Заявка не найдена.");

  if (params.action === "accept_application") {
    if (!leader || request.state_id !== params.currentStateId || request.kind !== "application") throw new Error("Нет прав принять эту заявку.");
    const { data: freeport, error: freeportError } = await supabase.from("states").select("id").eq("is_freeport", true).single();
    if (freeportError || !freeport) throw new Error("Freeport не найден.");
    const { data: stillFree, error: memberError } = await supabase
      .from("state_members")
      .select("id")
      .eq("state_id", freeport.id)
      .eq("player_id", request.player_id)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!stillFree) throw new Error("Игрок уже покинул Freeport. Обновите список кандидатов.");
    const pmap = await playerMap([String(request.player_id)]);
    const inviteLink = await inviteForState(params.currentStateId, String(pmap.get(String(request.player_id))?.display_name || "Recruit"));
    await updatePendingRequest(requestId, {
      status: "accepted", invite_link: inviteLink, decided_by_player_id: params.playerId,
    });
    return;
  }

  if (params.action === "accept_offer") {
    if (!params.currentStateIsFreeport || request.player_id !== params.playerId || request.kind !== "offer") throw new Error("Это предложение адресовано другому игроку.");
    const pmap = await playerMap([params.playerId]);
    const inviteLink = await inviteForState(String(request.state_id), String(pmap.get(params.playerId)?.display_name || "Recruit"));
    await updatePendingRequest(requestId, { status: "accepted", invite_link: inviteLink });
    return;
  }

  if (params.action === "reject") {
    const canReject = (leader && request.state_id === params.currentStateId) || (params.currentStateIsFreeport && request.player_id === params.playerId);
    if (!canReject) throw new Error("Нет прав изменить эту заявку.");
    await updatePendingRequest(requestId, { status: "rejected" });
    return;
  }

  if (params.action === "withdraw") {
    if (request.player_id !== params.playerId) throw new Error("Это не ваша заявка.");
    await updatePendingRequest(requestId, { status: "withdrawn" });
    return;
  }

  throw new Error("Неизвестное действие набора.");
}
