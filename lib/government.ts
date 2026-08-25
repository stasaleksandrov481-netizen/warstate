import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getChat, getChatAdministrators, getChatMemberCount, telegramApi } from "@/lib/telegram-bot";
import { getElection, finalizeElection } from "@/lib/politics";
import type { GovernmentView } from "@/lib/types";
import { isProjectAdminTelegramId } from "@/lib/config";

// Any government action taken from the Mini App (as opposed to a Telegram
// !command, which already replies in the chat itself) must still be visible
// to the whole state chat. This is the single notification point every
// Mini App government button routes through.
export async function notifyStateChat(stateId: string, text: string) {
  try {
    const supabase = getSupabaseAdmin();
    const { data: state, error } = await supabase.from("states").select("telegram_chat_id").eq("id", stateId).maybeSingle();
    if (error || !state?.telegram_chat_id) return;
    const chatId = Number(state.telegram_chat_id);
    if (!Number.isFinite(chatId) || !chatId) return;
    await telegramApi("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  } catch (notifyError) {
    // A notification failure must never roll back or fail the underlying
    // government action; it is best-effort visibility only.
    console.warn("WARSTATE government chat notification skipped", notifyError);
  }
}

const START_BUILDINGS = ["hq","barracks","mine","refinery","farm","lab","outpost","trade_chamber"] as const;

function displayName(user: { first_name?: string; last_name?: string; username?: string; id: number }) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username || String(user.id);
}

export async function registerTelegramState(chatId: number) {
  const supabase = getSupabaseAdmin();
  const [chat, admins, memberCount] = await Promise.all([
    getChat(chatId),
    getChatAdministrators(chatId),
    getChatMemberCount(chatId),
  ]);
  const creator = admins.find((item) => item.status === "creator" && !item.user?.is_bot);
  if (!creator?.user?.id) throw new Error("Telegram не вернул владельца чата. Бот должен быть участником группы.");

  const founderUser = creator.user;
  const { data: founder, error: founderError } = await supabase.from("players").upsert({
    telegram_id: founderUser.id,
    username: founderUser.username || null,
    display_name: displayName(founderUser),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "telegram_id" }).select("id").single();
  if (founderError) throw founderError;
  if (!founder) throw new Error("Не удалось создать профиль Основателя.");

  const { data: existing, error: existingError } = await supabase.from("states").select("*").eq("telegram_chat_id", chatId).maybeSingle();
  if (existingError) throw existingError;

  let state = existing;
  if (!state) {
    // A fixed, fairly dark lightness (regardless of hue) keeps the badges,
    // emblems and letter avatars that always render light/white text on top
    // of this color readable for every generated hue — a light hue (yellow,
    // cyan, light green) at high lightness made that text nearly invisible.
    const color = `hsl(${Math.abs(chatId) % 360} 62% 34%)`;
    const { data: created, error } = await supabase.from("states").insert({
      telegram_chat_id: chatId,
      telegram_chat_title: chat.title || `Chat ${Math.abs(chatId)}`,
      name: chat.title || `Государство ${Math.abs(chatId)}`,
      founder_player_id: founder.id,
      founder_verified_at: new Date().toISOString(),
      owner_player_id: null,
      credits: 1000,
      steel: 0,
      fuel: 0,
      food: 0,
      tech: 50,
      influence: 100,
      reputation: 100,
      army_power: 100,
      defense_power: 120,
      game_level: 1,
      color,
      telegram_member_count: Math.max(1, memberCount || 1),
      chat_avatar_file_id: chat.photo?.big_file_id || chat.photo?.small_file_id || null,
      chat_meta_synced_at: new Date().toISOString(),
      shield_until: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    }).select("*").single();
    if (error) throw error;
    state = created;
  } else {
    const patch: Record<string, unknown> = {
      telegram_chat_title: chat.title || state.telegram_chat_title || state.name,
      telegram_member_count: Math.max(1, memberCount || 1),
      chat_avatar_file_id: chat.photo?.big_file_id || chat.photo?.small_file_id || null,
      chat_meta_synced_at: new Date().toISOString(),
    };
    if (!state.founder_player_id) {
      patch.founder_player_id = founder.id;
      patch.founder_verified_at = new Date().toISOString();
    }
    const { data: updated, error } = await supabase.from("states").update(patch).eq("id", state.id).select("*").single();
    if (error) throw error;
    state = updated;
  }

  if (!state) throw new Error("Не удалось зарегистрировать государство.");

  // Founder identity belongs to states.founder_player_id and is independent of
  // citizenship. A Telegram user may own several groups, while state_members has
  // the deliberate one-home-state constraint. Never blindly INSERT a founder into
  // every state they own: that was the source of uq_state_members_one_home 500s.
  const { data: founderPlayer, error: founderPlayerError } = await supabase
    .from("players")
    .select("home_state_id")
    .eq("id", founder.id)
    .single();
  if (founderPlayerError) throw founderPlayerError;

  const { data: founderMembership, error: founderMembershipError } = await supabase
    .from("state_members")
    .select("id,role,state_id")
    .eq("player_id", founder.id)
    .maybeSingle();
  if (founderMembershipError) throw founderMembershipError;

  const founderCanTakeThisHome = !founderPlayer?.home_state_id || String(founderPlayer.home_state_id) === String(state.id);
  if (founderCanTakeThisHome) {
    if (!founderMembership) {
      const { error: founderHomeError } = await supabase.rpc("gw_set_player_home_state", {
        p_player_id: founder.id,
        p_state_id: state.id,
        p_role: "citizen",
        p_membership_verified_at: new Date().toISOString(),
      });
      if (founderHomeError && founderHomeError.code !== "23505") throw founderHomeError;
    }
    const { error: founderRoleError } = await supabase
      .from("state_members")
      .update({ role: "founder" })
      .eq("state_id", state.id)
      .eq("player_id", founder.id)
      .neq("role", "president");
    if (founderRoleError) throw founderRoleError;
  }

  const { error: buildingsError } = await supabase.from("buildings").upsert(
    START_BUILDINGS.map((building_type) => ({ state_id: state.id, building_type, level: 1 })),
    { onConflict: "state_id,building_type", ignoreDuplicates: true },
  );
  if (buildingsError) throw buildingsError;

  return state;
}

export async function resolveStateTarget(raw: string) {
  const supabase = getSupabaseAdmin();
  const value = String(raw || "").trim();
  if (!value) throw new Error("Укажите @юз государства.");
  if (value.startsWith("@") || !/^-?\d+$/.test(value)) {
    const handle = value.replace(/^@/, "").toLowerCase();
    const { data, error } = await supabase.from("states")
      .select("id,name,state_username,telegram_chat_id,is_freeport,is_beginner_island")
      .ilike("state_username", handle)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Государство @${handle} не найдено.`);
    if (data.is_freeport) throw new Error("Freeport — нейтральная территория.");
    return data;
  }
  const chatId = Number(value);
  const { data, error } = await supabase.from("states")
    .select("id,name,state_username,telegram_chat_id,is_freeport,is_beginner_island")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Государство цели ещё не зарегистрировано.");
  if (data.is_freeport) throw new Error("Freeport — нейтральная территория.");
  return data;
}

export async function searchStates(query: string) {
  const supabase = getSupabaseAdmin();
  const q = String(query || "").trim().replace(/^@/, "");
  if (q.length < 2) throw new Error("Введите минимум 2 символа для поиска.");
  const safe = q.replace(/[^a-zA-Z0-9_а-яА-ЯёЁ -]/g, "").slice(0, 32);
  if (safe.length < 2) throw new Error("Введите минимум 2 символа для поиска.");
  const { data, error } = await supabase.from("states")
    .select("id,name,state_username,rating,game_level")
    .eq("is_freeport", false)
    .or(`name.ilike.%${safe}%,state_username.ilike.%${safe}%`)
    .order("rating", { ascending: false })
    .limit(10);
  if (error) throw error;
  return data || [];
}

export async function resolveStateMemberByUsername(stateId: string, raw: string) {
  const supabase = getSupabaseAdmin();
  const username = String(raw || "").trim().replace(/^@/, "");
  if (!username) throw new Error("Укажите @username игрока.");
  const { data: player, error: playerError } = await supabase.from("players").select("id,telegram_id,display_name,username").ilike("username", username).maybeSingle();
  if (playerError) throw playerError;
  if (!player) throw new Error(`Игрок @${username} ещё не зарегистрирован в WARSTATE.`);
  const { data: member, error: memberError } = await supabase.from("state_members").select("role").eq("state_id", stateId).eq("player_id", player.id).maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new Error(`@${username} не является гражданином этого государства.`);
  return { ...player, role: member.role };
}


export async function resolveStateMemberByTelegramId(stateId: string, telegramId: number) {
  const supabase = getSupabaseAdmin();
  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("id,telegram_id,display_name,username")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (playerError) throw playerError;
  if (!player) throw new Error("Игрок ещё не зарегистрирован в WARSTATE. Пусть напишет !вступить в этом чате или любое сообщение после добавления бота.");
  const { data: member, error: memberError } = await supabase
    .from("state_members")
    .select("role")
    .eq("state_id", stateId)
    .eq("player_id", player.id)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new Error("Игрок зарегистрирован, но ещё не вступил в государство этого чата. Пусть напишет !вступить здесь.");
  return { ...player, role: member.role };
}

export async function setDeputyByPlayerId(stateId: string, actorPlayerId: string, targetPlayerId: string, enabled: boolean) {
  const supabase = getSupabaseAdmin();
  const { data: target, error: targetError } = await supabase
    .from("players")
    .select("id,telegram_id,display_name,username")
    .eq("id", targetPlayerId)
    .single();
  if (targetError) throw targetError;
  const { error } = await supabase.rpc("gw_set_deputy", {
    p_state_id: stateId,
    p_founder_player_id: actorPlayerId,
    p_target_player_id: targetPlayerId,
    p_enabled: enabled,
  });
  if (error) throw error;
  return target;
}

export async function getGovernmentView(stateId: string, playerId: string): Promise<GovernmentView> {
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase
    .from("states")
    .select("founder_player_id,owner_player_id,state_username,telegram_chat_title")
    .eq("id", stateId)
    .single();
  if (stateError) throw stateError;

  const leadershipIds = [...new Set([state?.founder_player_id, state?.owner_player_id].filter(Boolean).map(String))];
  const [leadersRes, deputiesRes, actorRes] = await Promise.all([
    leadershipIds.length
      ? supabase.from("players").select("id,display_name,username").in("id", leadershipIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    supabase
      .from("state_members")
      .select("player_id,role,player:players!state_members_player_id_fkey(display_name,username)")
      .eq("state_id", stateId)
      .in("role", ["minister", "deputy"]),
    supabase.from("players").select("telegram_id").eq("id", playerId).maybeSingle(),
  ]);
  if (leadersRes.error) throw leadersRes.error;
  if (deputiesRes.error) throw deputiesRes.error;
  if (actorRes.error) throw actorRes.error;

  const leaders = new Map((leadersRes.data || []).map((row: any) => [String(row.id), row]));
  const memberFromPlayer = (id: string | null | undefined, role: string) => {
    if (!id) return null;
    const row: any = leaders.get(String(id));
    if (!row) return null;
    return {
      playerId: String(row.id),
      displayName: String(row.display_name || "Игрок"),
      username: row.username ? String(row.username) : null,
      role,
    };
  };
  const deputies = (deputiesRes.data || []).slice(0, 3).map((row: any) => ({
    playerId: String(row.player_id),
    displayName: String(row.player?.display_name || "Игрок"),
    username: row.player?.username ? String(row.player.username) : null,
    role: String(row.role),
  }));
  const founderId = state?.founder_player_id ? String(state.founder_player_id) : null;
  const presidentId = state?.owner_player_id ? String(state.owner_player_id) : null;

  return {
    stateUsername: state?.state_username ? String(state.state_username) : null,
    telegramChatTitle: state?.telegram_chat_title ? String(state.telegram_chat_title) : null,
    founder: memberFromPlayer(founderId, "founder"),
    president: memberFromPlayer(presidentId, presidentId && founderId === presidentId ? "founder_president" : "president"),
    deputies,
    canFounderManage: Boolean(founderId && founderId === playerId),
    canProjectAdmin: isProjectAdminTelegramId(actorRes.data?.telegram_id),
  };
}

export async function openGovernmentElection(stateId: string, founderPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_open_30m_election", { p_state_id: stateId, p_founder_player_id: founderPlayerId });
  if (error) throw error;
  return String(data);
}

export async function voteForUsername(stateId: string, voterPlayerId: string, username: string) {
  const target = await resolveStateMemberByUsername(stateId, username);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_vote_for_player", { p_state_id: stateId, p_voter_player_id: voterPlayerId, p_target_player_id: target.id });
  if (error) throw error;
  return { data, target };
}

export async function appointPresidentByPlayerId(stateId: string, founderPlayerId: string, targetPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { data: target, error: targetError } = await supabase
    .from("players")
    .select("id,telegram_id,display_name,username")
    .eq("id", targetPlayerId)
    .single();
  if (targetError) throw targetError;
  const { error } = await supabase.rpc("gw_appoint_president", {
    p_state_id: stateId,
    p_founder_player_id: founderPlayerId,
    p_target_player_id: targetPlayerId,
  });
  if (error) {
    const message = String(error.message || "");
    if (String(founderPlayerId) === String(targetPlayerId) && (error.code === "PGRST202" || message.includes("Основатель не может занимать вторую роль"))) {
      throw new Error("Для совмещения ролей Основатель + Президент примените миграцию 023_founder_president_admin.sql.");
    }
    throw error;
  }
  return target;
}

export async function appointPresident(stateId: string, founderPlayerId: string, username: string) {
  const target = await resolveStateMemberByUsername(stateId, username);
  return appointPresidentByPlayerId(stateId, founderPlayerId, target.id);
}

export async function requestFounderSelfPresidency(stateId: string, founderPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase
    .from("states")
    .select("founder_player_id")
    .eq("id", stateId)
    .single();
  if (stateError) throw stateError;
  if (String(state?.founder_player_id || "") !== founderPlayerId) throw new Error("Самовыдвижение доступно только Основателю этого государства.");

  let electionId: string | null = null;
  try {
    electionId = await openGovernmentElection(stateId, founderPlayerId);
  } catch (error: any) {
    const message = String(error?.message || error || "");
    if (!message.toLocaleLowerCase("ru-RU").includes("выборы уже идут")) throw error;
  }

  // Founder self-promotion is a nomination, not a self-vote. Migration 023
  // requires another citizen's vote and a majority of votes cast before the Founder can win.
  const { data, error } = await supabase.rpc("gw_nominate_founder_for_president", {
    p_state_id: stateId,
    p_founder_player_id: founderPlayerId,
  });
  if (error) {
    if (error.code === "PGRST202") throw new Error("Не применена миграция 023_founder_president_admin.sql.");
    throw error;
  }
  return electionId || String((data as any)?.electionId || "") || null;
}

export async function removePresident(stateId: string, founderPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("gw_remove_president", { p_state_id: stateId, p_founder_player_id: founderPlayerId });
  if (error) throw error;
}

export async function setDeputy(stateId: string, actorPlayerId: string, username: string, enabled: boolean) {
  const target = await resolveStateMemberByUsername(stateId, username);
  return setDeputyByPlayerId(stateId, actorPlayerId, target.id, enabled);
}

export async function setStateUsername(stateId: string, founderPlayerId: string, username: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_set_state_username", { p_state_id: stateId, p_actor_player_id: founderPlayerId, p_username: username });
  if (error) throw error;
  return data;
}

export async function renameState(stateId: string, founderPlayerId: string, name: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_rename_state", { p_state_id: stateId, p_actor_player_id: founderPlayerId, p_name: name });
  if (error) throw error;
  return data;
}

export async function deleteState(stateId: string, founderPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("gw_delete_state", {
    p_state_id: stateId,
    p_actor_player_id: founderPlayerId,
  });
  if (error) {
    if (error.code === "PGRST202") throw new Error("Не применена миграция 018_state_switch_delete_ui.sql.");
    throw error;
  }
  return data;
}

export async function recordChatActivity(chatId: number, telegramId: number) {
  const supabase = getSupabaseAdmin();
  const { data: state, error: stateError } = await supabase.from("states").select("id").eq("telegram_chat_id", chatId).maybeSingle();
  if (stateError) throw stateError;
  if (!state) return { applied: false, reason: "state_missing" };
  const { data, error } = await supabase.rpc("gw_record_chat_activity", { p_telegram_id: telegramId, p_state_id: state.id });
  if (error) throw error;
  return data;
}

export async function finalizeDueElections() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("state_elections").select("id,state_id").eq("status", "open").lte("ends_at", new Date().toISOString()).limit(50);
  if (error) throw error;
  const results: Array<{ electionId: string; stateId: string; result: any }> = [];
  for (const row of data || []) {
    results.push({ electionId: row.id, stateId: row.state_id, result: await finalizeElection(row.id) });
  }
  return results;
}

export async function getCurrentElection(stateId: string, playerId: string) {
  return getElection(stateId, playerId);
}
