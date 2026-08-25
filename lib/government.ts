import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getChat, getChatAdministrators, getChatMemberCount, telegramApi } from "@/lib/telegram-bot";
import { getElection, finalizeElection } from "@/lib/politics";
import type { GovernmentView } from "@/lib/types";

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
    // Legacy versions used owner_player_id as the president. Once Telegram confirms
    // the creator as Founder, do not silently leave the same person in two offices.
    if (String(state.owner_player_id || "") === String(founder.id)) patch.owner_player_id = null;
    const { data: updated, error } = await supabase.from("states").update(patch).eq("id", state.id).select("*").single();
    if (error) throw error;
    state = updated;
  }

  if (!state) throw new Error("Не удалось зарегистрировать государство.");

  const { error: founderMemberError } = await supabase.from("state_members").upsert({
    state_id: state.id,
    player_id: founder.id,
    role: "founder",
  }, { onConflict: "state_id,player_id" });
  if (founderMemberError) throw founderMemberError;

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

export async function getGovernmentView(stateId: string, playerId: string): Promise<GovernmentView> {
  const supabase = getSupabaseAdmin();
  const [{ data: state, error: stateError }, { data: members, error: memberError }] = await Promise.all([
    supabase.from("states").select("founder_player_id,state_username,telegram_chat_title").eq("id", stateId).single(),
    supabase.from("state_members").select("player_id,role,player:players!state_members_player_id_fkey(display_name,username)").eq("state_id", stateId).in("role", ["founder","president","minister","deputy"]),
  ]);
  if (stateError) throw stateError;
  if (memberError) throw memberError;
  const rows = members || [];
  const mapMember = (row: any) => ({
    playerId: String(row.player_id),
    displayName: String(row.player?.display_name || "Игрок"),
    username: row.player?.username ? String(row.player.username) : null,
    role: String(row.role),
  });
  return {
    stateUsername: state?.state_username ? String(state.state_username) : null,
    telegramChatTitle: state?.telegram_chat_title ? String(state.telegram_chat_title) : null,
    founder: rows.find((row: any) => row.role === "founder") ? mapMember(rows.find((row: any) => row.role === "founder")) : null,
    president: rows.find((row: any) => row.role === "president") ? mapMember(rows.find((row: any) => row.role === "president")) : null,
    deputies: rows.filter((row: any) => ["minister","deputy"].includes(String(row.role))).slice(0, 3).map(mapMember),
    canFounderManage: String(state?.founder_player_id || "") === playerId,
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

export async function appointPresident(stateId: string, founderPlayerId: string, username: string) {
  const target = await resolveStateMemberByUsername(stateId, username);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("gw_appoint_president", { p_state_id: stateId, p_founder_player_id: founderPlayerId, p_target_player_id: target.id });
  if (error) throw error;
  return target;
}

export async function removePresident(stateId: string, founderPlayerId: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("gw_remove_president", { p_state_id: stateId, p_founder_player_id: founderPlayerId });
  if (error) throw error;
}

export async function setDeputy(stateId: string, founderPlayerId: string, username: string, enabled: boolean) {
  const target = await resolveStateMemberByUsername(stateId, username);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("gw_set_deputy", { p_state_id: stateId, p_founder_player_id: founderPlayerId, p_target_player_id: target.id, p_enabled: enabled });
  if (error) throw error;
  return target;
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
