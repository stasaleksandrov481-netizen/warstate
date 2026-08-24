import { getBattleView } from "@/lib/battle";
import { getAlliedStateChats, performDiplomacyAction } from "@/lib/diplomacy";
import { bootstrapGame, tickState } from "@/lib/game";
import { startWarAction, upgradeBuildingAction } from "@/lib/actions";
import { addAllianceBattleSupport, completeDailyActivity, surrenderBattle } from "@/lib/strategy";
import { appointPresident, openGovernmentElection, removePresident, renameState, resolveStateMemberByUsername, resolveStateTarget, searchStates, setDeputy, setStateUsername, voteForUsername } from "@/lib/government";
import { claimDailyMission } from "@/lib/missions";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  DUTY_ROLE_LABELS,
  castStateVote,
  createStateVote,
  executeApprovedStateVote,
  getDueVotesForChat,
  getOpenStateVote,
  getVoteSummary,
  listDutyRoles,
  maybeFinalizeStateVote,
  parseDutyRole,
  resolveSpyQuest,
  setDutyRole,
  startSpyQuest,
} from "@/lib/community";
import type { BuildingType, WarType } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";
import { telegramGameGuideText } from "@/lib/game-guide";
import { publishStateEvent } from "@/lib/state-events";

const LEADERS = new Set(["president", "minister", "deputy", "curator"]);
const WAR_LEADERS = new Set(["president", "minister", "deputy"]);

const BUILDING_ALIASES: Record<string, BuildingType> = {
  hq: "hq", штаб: "hq", казначейство: "hq",
  barracks: "barracks", казармы: "barracks", казарма: "barracks",
  mine: "mine", шахта: "mine",
  refinery: "refinery", нпз: "refinery",
  farm: "farm", ферма: "farm",
  lab: "lab", лаборатория: "lab", академия: "lab",
  outpost: "outpost", застава: "outpost",
  trade_chamber: "trade_chamber", торговая_палата: "trade_chamber", палата: "trade_chamber",
};

const WAR_TYPES: Record<string, WarType> = {
  raid: "raid", рейд: "raid",
  siege: "siege", осада: "siege",
  territory: "territory", территория: "territory",
};

function resourceLine(snapshot: { state: { treasury: { credits: number; steel: number; fuel: number; food: number; tech: number } } }): string {
  const t = snapshot.state.treasury;
  return `💰 ${t.credits.toLocaleString("ru-RU")} · ⚙️ ${t.steel.toLocaleString("ru-RU")} · ⛽ ${t.fuel.toLocaleString("ru-RU")} · 🌾 ${t.food.toLocaleString("ru-RU")} · 🔬 ${t.tech.toLocaleString("ru-RU")}`;
}

function telegramUser(from: any): TelegramUser {
  return {
    id: Number(from.id),
    first_name: String(from.first_name || "Игрок"),
    last_name: from.last_name ? String(from.last_name) : undefined,
    username: from.username ? String(from.username) : undefined,
  };
}

const MESSAGE_DIVIDER = "────────────";

function decorateMessage(text: string) {
  const clean = String(text || "").trim();
  if (!clean || clean.includes(MESSAGE_DIVIDER)) return clean;
  const lineBreak = clean.indexOf("\n");
  if (lineBreak <= 0) return `⚔ WARSTATE\n${MESSAGE_DIVIDER}\n${clean}`;
  const title = clean.slice(0, lineBreak).trim();
  const body = clean.slice(lineBreak).replace(/^\s+/, "");
  if (!title || !body) return clean;
  return `${title}\n${MESSAGE_DIVIDER}\n${body}`;
}

async function send(chatId: number, text: string, keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: decorateMessage(text),
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

function typeLabel(type: WarType) {
  return type === "siege" ? "осада" : type === "territory" ? "спор за территорию" : "рейд";
}

function voteKeyboard(voteId: string) {
  return [[
    { text: "✅ За", callback_data: `gw:vote:yes:${voteId}` },
    { text: "❌ Против", callback_data: `gw:vote:no:${voteId}` },
  ]];
}

function voteProgressText(summary: { yes: number; no: number; eligible: number; quorum: number; vote: { ends_at: string } }) {
  const minutes = Math.max(0, Math.ceil((new Date(summary.vote.ends_at).getTime() - Date.now()) / 60_000));
  return `✅ ${summary.yes} · ❌ ${summary.no} · граждан ${summary.eligible} · кворум ${summary.quorum} · осталось ~${minutes} мин.`;
}

async function statePairForVote(vote: { state_id: string; target_state_id: string }) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select("id,name,state_username,telegram_chat_id")
    .in("id", [vote.state_id, vote.target_state_id]);
  if (error) throw error;
  const actor = (data || []).find((row: any) => String(row.id) === String(vote.state_id));
  const target = (data || []).find((row: any) => String(row.id) === String(vote.target_state_id));
  if (!actor || !target) throw new Error("Государство голосования не найдено.");
  return { actor, target };
}

async function announceApprovedVoteExecution(result: any) {
  if (!result?.executed) return;
  const { actor, target } = await statePairForVote(result.vote);
  const actorChatId = Number(actor.telegram_chat_id);
  const targetChatId = Number(target.telegram_chat_id);

  if (result.kind === "war") {
    const battle = await getBattleView(String(result.battleId), null);
    const text = `🚨 ГОЛОСОВАНИЕ ПРИНЯТО · ${typeLabel(result.battleType).toUpperCase()}\n\n${actor.name} атакует ${target.name}.\nСоюзники могут поддержать бой через кнопки или команду !поддержать ${battle.id} defense/attack.`;
    const sends: Promise<unknown>[] = [];
    if (Number.isSafeInteger(actorChatId)) sends.push(send(actorChatId, text, [[{ text: "⚔️ Войти в бой", url: miniAppLink(actorChatId) }]]));
    if (Number.isSafeInteger(targetChatId)) sends.push(send(targetChatId, text, [
      [{ text: "🛡️ Организовать оборону", url: miniAppLink(targetChatId) }],
      [{ text: "🤝 Запросить союзную помощь", callback_data: `gw:battle:support:${battle.id}` }],
      [{ text: "🏳 Сдаться", callback_data: `gw:battle:surrender:${battle.id}` }],
    ]));
    const [ourAllies, theirAllies] = await Promise.all([getAlliedStateChats(String(actor.id)), getAlliedStateChats(String(target.id))]);
    sends.push(
      ...ourAllies.map((ally) => send(ally.telegramChatId, `🤝 Союзный запрос: ${actor.name} просит помощи в бою против ${target.name}.`, [
        [{ text: "⚔️ Помочь атакой", callback_data: `gw:support:attacker:${battle.id}` }],
        [{ text: "Пропустить", callback_data: `gw:support:skip:${battle.id}` }],
      ])),
      ...theirAllies.map((ally) => send(ally.telegramChatId, `🤝 Союзный запрос: ${target.name} просит помощи в обороне против ${actor.name}.`, [
        [{ text: "🛡️ Помочь защитой", callback_data: `gw:support:defender:${battle.id}` }],
        [{ text: "Пропустить", callback_data: `gw:support:skip:${battle.id}` }],
      ])),
    );
    await Promise.allSettled(sends);
    return;
  }

  if (result.action === "accept") {
    const text = `🤝 ГОЛОСОВАНИЕ ПРИНЯТО\n\n${actor.name} и ${target.name} заключили союз.`;
    await Promise.allSettled([
      Number.isSafeInteger(actorChatId) ? send(actorChatId, text) : Promise.resolve(),
      Number.isSafeInteger(targetChatId) ? send(targetChatId, text) : Promise.resolve(),
    ]);
  } else {
    const actorText = `🤝 ГОЛОСОВАНИЕ ПРИНЯТО\n\nПредложение союза отправлено государству «${target.name}».`;
    const acceptTarget = actor.state_username ? `@${actor.state_username}` : String(actor.id);
    const targetText = `🤝 ${actor.name} предлагает союз. Чтобы заключить его, Дипломат или Президент запускает голосование командой:\n!союз принять ${acceptTarget}`;
    await Promise.allSettled([
      Number.isSafeInteger(actorChatId) ? send(actorChatId, actorText) : Promise.resolve(),
      Number.isSafeInteger(targetChatId) ? send(targetChatId, targetText, [[{ text: "🤝 Дипломатия", url: miniAppLink(targetChatId) }]]) : Promise.resolve(),
    ]);
  }
}

export async function processDueGroupVotes(chatId: number) {
  const due = await getDueVotesForChat(chatId);
  for (const vote of due) {
    if (vote.status === "approved" && !vote.executed_at) {
      const execution = await executeApprovedStateVote(vote.id);
      await announceApprovedVoteExecution(execution);
      continue;
    }
    const resolved: any = await maybeFinalizeStateVote(vote.id);
    if (!resolved.finalized) continue;
    if (resolved.status === "approved") {
      const execution = await executeApprovedStateVote(vote.id);
      await announceApprovedVoteExecution(execution);
    } else {
      await send(chatId, `🗳 Голосование завершено: решение отклонено. ${voteProgressText(resolved)}`);
    }
  }
}

export async function handleGroupTextCommand(message: any): Promise<boolean> {
  const text = String(message?.text || "").trim();
  if (!text.startsWith("!")) return false;
  const chatId = Number(message?.chat?.id);
  const from = message?.from;
  if (!Number.isSafeInteger(chatId) || !from?.id) return false;

  const [rawCommand, ...args] = text.slice(1).trim().split(/\s+/);
  // Allow both !команда and !команда@botname in supergroups/topics.
  const command = String(rawCommand || "").split("@")[0].toLocaleLowerCase("ru-RU");

  try {
    if (["играть", "как_играть", "какиграть", "гайд", "guide"].includes(command)) {
      await send(chatId, telegramGameGuideText(), [[{ text: "🌊 Открыть WARSTATE", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (["help", "помощь", "команды"].includes(command)) {
      await send(chatId,
        "🧭 WARSTATE · ПОМОЩЬ\n\n" +
        "📖 Новичок? !играть — подробная инструкция от первого входа до войн и союзов.\n\n" +
        "🏛 ГОСУДАРСТВО\n" +
        "!государство — карточка страны\n" +
        "!статус — уровень, армия, оборона и прочность\n" +
        "!ресурсы / !казна / !налоги — экономика и доход\n" +
        "!карта — карта островов и переход в другое государство\n" +
        "!государства — список государств · !найти @state — поиск\n" +
        "!рейтинг — топ по ELO · !профиль — роль, XP и бои\n" +
        "!вклад — твой вклад в развитие страны\n\n" +
        "👑 УПРАВЛЕНИЕ\n" +
        "!президент / !замы — руководство государства\n" +
        "!назначитьпрезидента @user / !снятьпрезидента\n" +
        "!назначитьзама @user / !снятьзама @user\n" +
        "!роли — список специализаций · !роль @user роль — назначить\n" +
        "!выборы — открыть выборы · !голосовать @user — отдать голос\n" +
        "!голосование — текущее решение войны/союза\n" +
        "!название ... / !юз ... — изменить имя и игровой @юз\n\n" +
        "⚔ ВОЙНА И РАЗВЕДКА\n" +
        "!война @state raid|siege|territory — вынести атаку на голосование\n" +
        "!бой — состояние текущего сражения\n" +
        "!разведка @state — оценка армии и обороны\n" +
        "!шпион @state — личная спецоперация Шпиона\n" +
        "!поддержать ID defense|attack — помочь союзнику\n" +
        "!сдаться — капитуляция в активном бою\n\n" +
        "🤝 ДИПЛОМАТИЯ\n" +
        "!альянсы — действующие союзы\n" +
        "!союз @state — вынести союз на голосование\n" +
        "!союз принять @state — голосование за принятие\n" +
        "!союз отклонить @state — отклонить предложение\n" +
        "!разорватьсоюз @state — завершить союз\n\n" +
        "🏗 РАЗВИТИЕ\n" +
        "!постройки — уровни инфраструктуры\n" +
        "!улучшить шахта — начать улучшение\n" +
        "!миссия — ежедневные задачи\n" +
        "!награда — забрать готовую награду\n" +
        "!активность — доступные операции дня\n\n" +
        "💬 За общение: +2 XP и +1 вклад не чаще раза в минуту. Каждые 10 обычных сообщений граждан дают государству +1 ко всем ресурсам.\n\n" +
        "⇄ Смена государства: открой !карта → выбери остров → «Перейти». Бот обязательно проверит, что ты состоишь в Telegram-чате выбранного государства."
      );
      return true;
    }

    const snapshot = await bootstrapGame(telegramUser(from), chatId);

    if (command === "государство" || command === "state") {
      const gov = snapshot.government;
      const president = gov.president ? `${gov.president.displayName}${gov.president.username ? ` (@${gov.president.username})` : ""}` : "не назначен";
      const allies = snapshot.diplomacy.filter((item) => item.status === "allied").map((item) => item.otherStateName);
      await send(chatId,
        `🏛 ${snapshot.state.name}\n` +
        `🌐 ${snapshot.state.stateUsername ? `@${snapshot.state.stateUsername}` : "юз не создан"}\n` +
        `Президент: ${president}\n` +
        `Уровень: ${snapshot.state.level}\n` +
        `${resourceLine(snapshot)}\n` +
        `⚔️ Армия ${snapshot.state.armyPower} · 🛡 Оборона ${snapshot.state.defensePower}\n` +
        `🤝 Альянс: ${allies.length ? allies.join(", ") : "нет"}`,
        [[{ text: "🏛 Открыть государство", url: miniAppLink(chatId, snapshot.state.id) }]],
      );
      return true;
    }

    if (command === "президент") {
      const p = snapshot.government.president;
      await send(chatId, p ? `👑 Президент: ${p.displayName}${p.username ? ` (@${p.username})` : ""}` : "👑 Президент пока не назначен. Основатель может назначить его или запустить 30-минутные выборы.");
      return true;
    }

    if (command === "замы") {
      const deputies = snapshot.government.deputies;
      await send(chatId, `🛡 ЗАМЕСТИТЕЛИ · ${deputies.length}/3\n\n${deputies.length ? deputies.map((d, i) => `${i + 1}. ${d.displayName}${d.username ? ` (@${d.username})` : ""}`).join("\n") : "Заместителей пока нет."}`);
      return true;
    }

    if (command === "роли" || command === "roles") {
      const duties = await listDutyRoles(snapshot.state.id);
      const dutyLines = duties.length
        ? duties.map((item) => `• ${DUTY_ROLE_LABELS[item.dutyRole]} — ${item.displayName}${item.username ? ` (@${item.username})` : ""}`).join("\n")
        : "Специализации пока не назначены.";
      const president = snapshot.government.president;
      await send(chatId,
        `🎖 РОЛИ ГОСУДАРСТВА\n\n` +
        `👑 Президент — ${president ? `${president.displayName}${president.username ? ` (@${president.username})` : ""}` : "не назначен"}\n\n` +
        `${dutyLines}\n\n` +
        `⛏ Шахтёр: +8% к стали за каждого, максимум +40%.\n` +
        `🏗 Рабочий: +4% ко всей добыче за каждого, максимум +20%.`
      );
      return true;
    }

    if (command === "роль" || command === "role") {
      const targetRaw = String(args[0] || "");
      const roleRaw = String(args[1] || "");
      if (!targetRaw || !roleRaw) throw new Error("Формат: !роль @username дипломат|шпион|шахтер|рабочий|снять");
      const target = await resolveStateMemberByUsername(snapshot.state.id, targetRaw);
      const clear = ["снять", "none", "clear", "нет"].includes(roleRaw.toLocaleLowerCase("ru-RU"));
      const dutyRole = clear ? null : parseDutyRole(roleRaw);
      if (!clear && !dutyRole) throw new Error("Специализация: дипломат, шпион, шахтер или рабочий.");
      await setDutyRole({ stateId: snapshot.state.id, actorPlayerId: snapshot.player.id, targetPlayerId: target.id, dutyRole });
      await send(chatId, dutyRole
        ? `🎖 ${target.display_name}${target.username ? ` (@${target.username})` : ""} получает специализацию «${DUTY_ROLE_LABELS[dutyRole]}».`
        : `🎖 Специализация ${target.display_name}${target.username ? ` (@${target.username})` : ""} снята.`);
      return true;
    }

    if (command === "выборы") {
      if (!snapshot.government.canFounderManage) throw new Error("Внеочередные выборы запускает только Основатель.");
      const electionId = await openGovernmentElection(snapshot.state.id, snapshot.player.id);
      await publishStateEvent(snapshot.state.id, "🗳 ВЫБОРЫ ПРЕЗИДЕНТА", "Началось голосование за нового президента государства.");
      await send(chatId, `🗳 ВЫБОРЫ ПРЕЗИДЕНТА\n\nГолосование открыто на 30 минут.\nКоманда: !голосовать @username\n\nИтог будет подведён автоматически при следующей активности государства.`);
      return true;
    }

    if (command === "голосовать") {
      const targetUsername = String(args[0] || "");
      if (!targetUsername) throw new Error("Формат: !голосовать @username");
      const { target } = await voteForUsername(snapshot.state.id, snapshot.player.id, targetUsername);
      await send(chatId, `🗳 Голос принят за ${target.display_name}${target.username ? ` (@${target.username})` : ""}.`);
      return true;
    }

    if (command === "назначитьпрезидента") {
      if (!snapshot.government.canFounderManage) throw new Error("Президента назначает только Основатель.");
      const target = await appointPresident(snapshot.state.id, snapshot.player.id, String(args[0] || ""));
      await send(chatId, `👑 ${target.display_name}${target.username ? ` (@${target.username})` : ""} назначен президентом.`);
      return true;
    }

    if (command === "снятьпрезидента") {
      if (!snapshot.government.canFounderManage) throw new Error("Президента снимает только Основатель.");
      await removePresident(snapshot.state.id, snapshot.player.id);
      await send(chatId, "👑 Президент снят с должности. Государство временно управляется без президента до назначения или выборов.");
      return true;
    }

    if (command === "назначитьзама" || command === "снятьзама") {
      if (!snapshot.government.canFounderManage) throw new Error("Заместителей назначает и снимает только Основатель.");
      const enabled = command === "назначитьзама";
      const target = await setDeputy(snapshot.state.id, snapshot.player.id, String(args[0] || ""), enabled);
      await publishStateEvent(snapshot.state.id, enabled ? "🛡 НАЗНАЧЕН ЗАМЕСТИТЕЛЬ" : "🛡 ЗАМЕСТИТЕЛЬ СНЯТ", `${target.displayName}${target.username ? ` (@${target.username})` : ""}`);
      await send(chatId, `${enabled ? "🛡 Назначен заместитель" : "🛡 Заместитель снят"}: ${target.display_name}${target.username ? ` (@${target.username})` : ""}.`);
      return true;
    }

    if (command === "создатьюз" || command === "юз") {
      if (!snapshot.government.canFounderManage) throw new Error("Юз государства меняет только Основатель.");
      const raw = String(args[0] || "");
      if (!raw) throw new Error(`Формат: !${command} north_empire`);
      const result: any = await setStateUsername(snapshot.state.id, snapshot.player.id, raw);
      await send(chatId, `🌐 Юз государства: @${String(result?.username || raw).replace(/^@/, "")}`);
      return true;
    }

    if (command === "название") {
      if (!snapshot.government.canFounderManage) throw new Error("Название государства меняет только Основатель.");
      const name = args.join(" ").trim();
      if (!name) throw new Error("Формат: !название Новое Государство");
      const result: any = await renameState(snapshot.state.id, snapshot.player.id, name);
      await send(chatId, `🏛 Государство теперь называется «${String(result?.name || name)}».`);
      return true;
    }

    if (command === "найти") {
      const found = await searchStates(args.join(" "));
      await send(chatId, `🔎 ПОИСК ГОСУДАРСТВ\n\n${found.length ? found.map((row: any, i: number) => `${i + 1}. ${row.name} ${row.state_username ? `@${row.state_username}` : "без юза"} · ур.${row.game_level} · ${row.rating} ELO`).join("\n") : "Ничего не найдено."}`);
      return true;
    }

    if (command === "рейтинг") {
      await send(chatId, `🏆 РЕЙТИНГ\n\n${snapshot.leaderboard.slice(0, 10).map((row) => `${row.rank}. ${row.name} · ${row.rating} ELO`).join("\n")}`);
      return true;
    }

    if (command === "карта") {
      const beginner = snapshot.islands.find((island) => island.isBeginnerIsland);
      await send(
        chatId,
        `🗺 КАРТА ГОСУДАРСТВ\n\n${beginner ? `🧭 ${beginner.name} · защищённая территория · ${beginner.memberCount} участников\n\n` : ""}Откройте мировую карту в Mini App. Остров новичков закреплён в радаре и доступен для выбора из любой точки мира.`,
        [
          ...(beginner ? [[{ text: "🧭 Выбрать Остров новичков", callback_data: `gw:map:island:${beginner.id}` }]] : []),
          [{ text: "🗺 Открыть карту", url: miniAppLink(chatId) }],
        ],
      );
      return true;
    }

    if (command === "альянсы") {
      const allies = snapshot.diplomacy.filter((item) => item.status === "allied");
      await send(chatId, `🤝 СОЮЗЫ\n\n${allies.length ? allies.map((item, i) => `${i + 1}. ${item.otherStateName}`).join("\n") : "Активных союзов нет."}`);
      return true;
    }

    if (command === "голосование" || command === "vote") {
      const openVote = await getOpenStateVote(snapshot.state.id);
      if (!openVote) {
        await send(chatId, "🗳 Сейчас активных государственных голосований нет.");
        return true;
      }
      if (openVote.status === "approved" && !openVote.executed_at) {
        const execution = await executeApprovedStateVote(openVote.id);
        await announceApprovedVoteExecution(execution);
        if (!execution.executed) await send(chatId, "🗳 Решение уже было исполнено другим запросом.");
        return true;
      }
      if (new Date(openVote.ends_at).getTime() <= Date.now()) {
        const resolved: any = await maybeFinalizeStateVote(openVote.id);
        if (resolved.status === "approved") await announceApprovedVoteExecution(await executeApprovedStateVote(openVote.id));
        else if (resolved.finalized) await send(chatId, `🗳 Голосование завершено: решение отклонено. ${voteProgressText(resolved)}`);
        return true;
      }
      const summary = await getVoteSummary(openVote.id);
      const { target } = await statePairForVote(openVote);
      const subject = openVote.vote_kind === "war"
        ? `объявить ${typeLabel(String(openVote.payload?.battleType || "raid") as WarType)} государству «${target.name}»`
        : `${String(openVote.payload?.action || "propose") === "accept" ? "принять союз" : "предложить союз"} с «${target.name}»`;
      await send(chatId, `🗳 ГОЛОСОВАНИЕ\n\nРешение: ${subject}.\n${voteProgressText(summary)}`, voteKeyboard(openVote.id));
      return true;
    }

    if (command === "статус" || command === "status") {
      const s = snapshot.state;
      const shield = s.shieldUntil && new Date(s.shieldUntil).getTime() > Date.now() ? " · 🛡️ щит активен" : "";
      const beginner = s.isBeginnerIsland ? "\n🧭 Остров новичков · максимум ур. 5 · атаки запрещены" : "";
      await send(chatId,
        `🏝️ ${s.name}${s.stateUsername ? ` · @${s.stateUsername}` : ""}\n` +
        `Ур. ${s.level}/${s.maxLevel} · ELO ${s.rating} · место #${s.seasonRank || "—"}\n` +
        `👥 активных ${s.activePlayers}/${s.memberCount.toLocaleString("ru-RU")} · размер ${s.stateSize.toFixed(2)}\n` +
        `⚔️ армия ${s.armyPower} · 🛡️ оборона ${s.defensePower} · репутация ${s.reputation}${shield}\n` +
        `Победы ${s.islandWins} · поражения ${s.islandLosses} · прочность ${s.islandIntegrity}%${beginner}\n\n` +
        resourceLine(snapshot),
        [[{ text: "🌊 Открыть государство", url: miniAppLink(chatId) }]],
      );
      return true;
    }

    if (command === "ресурсы" || command === "resources") {
      await tickState(snapshot.state.id);
      const fresh = await bootstrapGame(telegramUser(from), chatId);
      const p = fresh.state.productionPerHour;
      await send(chatId,
        `📦 КАЗНА ${fresh.state.name}\n\n${resourceLine(fresh)}\n\n` +
        `Доход/ч: 💰 +${p.credits} · ⚙️ +${p.steel} · ⛽ +${p.fuel} · 🌾 +${p.food} · 🔬 +${p.tech}`,
      );
      return true;
    }


    if (command === "профиль" || command === "profile") {
      const roleLabel = snapshot.player.role === "founder" ? "Основатель"
        : snapshot.player.role === "president" ? "Президент"
        : ["minister", "deputy"].includes(snapshot.player.role) ? "Заместитель"
        : snapshot.player.role === "curator" ? "Куратор"
        : snapshot.player.role === "general" ? "Генерал" : "Гражданин";
      const dutyLabel = snapshot.player.dutyRole ? DUTY_ROLE_LABELS[snapshot.player.dutyRole] : null;
      const supabase = getSupabaseAdmin();
      const { data: participations, error: participationError } = await supabase.from("battle_players").select("battle_id,team").eq("player_id", snapshot.player.id);
      if (participationError) throw participationError;
      const battleIds = [...new Set((participations || []).map((row: any) => String(row.battle_id)).filter(Boolean))];
      const { data: battles, error: battlesError } = battleIds.length
        ? await supabase.from("battles").select("id,winner_state_id,attacker_state_id,defender_state_id,status").in("id", battleIds)
        : { data: [] as any[], error: null };
      if (battlesError) throw battlesError;
      const battleById = new Map((battles || []).map((battle: any) => [String(battle.id), battle]));
      let wins = 0;
      let defenses = 0;
      for (const row of participations || []) {
        const battle: any = battleById.get(String((row as any).battle_id));
        if (!battle || battle.status !== "resolved") continue;
        const myState = (row as any).team === "attacker" ? battle.attacker_state_id : battle.defender_state_id;
        if (battle.winner_state_id && String(battle.winner_state_id) === String(myState)) wins += 1;
        if ((row as any).team === "defender") defenses += 1;
      }
      await send(chatId,
        `👤 ${snapshot.player.displayName}\n\nРоль: ${roleLabel}${dutyLabel ? ` · ${dutyLabel}` : ""}\nУровень: ${snapshot.player.level}\nОпыт: ${snapshot.player.xp.toLocaleString("ru-RU")} XP\nВклад: ${snapshot.player.contribution.toLocaleString("ru-RU")}\nПобеды: ${wins}\nЗащиты: ${defenses}\nГосударство: ${snapshot.state.name}${snapshot.state.stateUsername ? ` (@${snapshot.state.stateUsername})` : ""}`
      );
      return true;
    }

    if (command === "вклад" || command === "contribution") {
      const recent = snapshot.strategy.contributionEvents.slice(0, 8).map((event) => `+${event.amount} · ${event.source}`).join("\n");
      await send(chatId, `🏅 ВКЛАД ${snapshot.player.displayName}\n\nВсего: ${snapshot.player.contribution.toLocaleString("ru-RU")}\n\n${recent || "Начислений пока нет."}`);
      return true;
    }

    if (command === "государства" || command === "states") {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.from("states").select("name,state_username,game_level,rating,active_player_count,is_beginner_island").eq("is_freeport", false).order("rating", { ascending: false }).limit(15);
      if (error) throw error;
      const lines = (data || []).map((state: any, index: number) => `${index + 1}. ${state.is_beginner_island ? "🧭 " : ""}${state.name}${state.state_username ? ` · @${state.state_username}` : ""} · ур.${state.game_level} · ${state.rating} ELO · ${state.active_player_count} активных`);
      await send(chatId, `🌍 ГОСУДАРСТВА\n\n${lines.join("\n") || "Других государств пока нет."}`);
      return true;
    }

    if (command === "казна" || command === "налоги") {
      await tickState(snapshot.state.id);
      const fresh = await bootstrapGame(telegramUser(from), chatId);
      const p = fresh.state.productionPerHour;
      await send(chatId, `💰 КАЗНА И НАЛОГИ\n\n${resourceLine(fresh)}\n\nПассивное поступление/ч: 💰 +${p.credits} · ⚙️ +${p.steel} · ⛽ +${p.fuel} · 🌾 +${p.food} · 🔬 +${p.tech}.\nНалоги начисляются сервером автоматически вместе с экономическим тиком.`);
      return true;
    }

    if (command === "постройки") {
      await send(chatId, `🏗 ПОСТРОЙКИ\n\n${snapshot.buildings.map((b) => `${b.label} · ур.${b.level}${b.upgradeTargetLevel ? ` → ${b.upgradeTargetLevel}` : ""}`).join("\n")}`, [[{ text: "🏝 Открыть остров", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (command === "миссия") {
      await send(chatId, `🎖 МИССИИ\n\n${snapshot.dailyMissions.map((m) => `${m.claimed ? "✅" : m.progress >= m.target ? "🎁" : "•"} ${m.title}: ${m.progress}/${m.target} · ${m.rewardXp} XP${m.rewardCredits ? ` + ${m.rewardCredits} кредитов` : ""}`).join("\n")}`);
      return true;
    }

    if (command === "награда") {
      const mission = snapshot.dailyMissions.find((m) => !m.claimed && m.progress >= m.target);
      if (!mission) throw new Error("Сейчас нет готовой награды. Выполните миссии через !миссия.");
      await claimDailyMission(snapshot.player.id, snapshot.state.id, mission.id);
      await send(chatId, `🎁 Награда за «${mission.title}» получена: +${mission.rewardXp} XP${mission.rewardCredits ? ` · +${mission.rewardCredits} кредитов` : ""}.`);
      return true;
    }

    if (command === "активность" || command === "activity") {
      const activityKey = String(args[0] || "").toLowerCase();
      const optionKey = String(args[1] || "").toLowerCase();
      if (activityKey && optionKey) {
        const result: any = await completeDailyActivity(snapshot.player.id, snapshot.state.id, activityKey, optionKey);
        const resultText =
          `${result?.success ? "✅" : "⚠️"} ${result?.text || "Активность завершена."}\n` +
          `Награда: 💰 ${Number(result?.credits || 0)} · 🏛 ${Number(result?.influence || 0)} · 🔬 ${Number(result?.tech || 0)} · реп. ${Number(result?.reputation || 0)} · вклад +${Number(result?.contribution || 0)}`;
        try {
          await send(Number(from.id), resultText);
          await send(chatId, `🎯 ${snapshot.player.displayName}, результат активности отправлен вам в личный чат.`);
        } catch {
          // Telegram does not allow a bot to initiate a private chat. Keep the
          // completed activity visible instead of losing the authoritative result.
          await send(chatId, `${resultText}\n\nЧтобы дальше получать результаты лично, сначала откройте диалог с ботом и нажмите /start.`);
        }
        return true;
      }

      const available = snapshot.strategy.activities.filter((activity) => !activity.completed).slice(0, 4);
      const lines = available.flatMap((activity) => [
        `\n${activity.title} [${activity.key}]`,
        activity.description,
        ...activity.options.map((option) => `• ${option.label}: !активность ${activity.key} ${option.key} · риск ${Math.round(option.risk * 100)}%`),
      ]);
      await send(chatId,
        `🎯 АКТИВНОСТИ · ${snapshot.strategy.completedToday}/${snapshot.strategy.rules.maxDailyActivities}\n${lines.join("\n") || "\nНа сегодня всё выполнено."}`,
        [[{ text: "🎯 Открыть в Mini App", url: miniAppLink(chatId) }]],
      );
      return true;
    }

    if (command === "бой" || command === "battle" || command === "оборона" || command === "defense") {
      const battle = snapshot.activeBattle;
      if (!battle) {
        await send(chatId, "Сейчас государство не участвует в активном бою.");
        return true;
      }
      await send(chatId,
        `⚔️ ${typeLabel(battle.battleType).toUpperCase()}\n${battle.attackerName} ${battle.attackerScore}:${battle.defenderScore} ${battle.defenderName}\n\n` +
        `Размеры: ${battle.attackerStateSize.toFixed(2)} / ${battle.defenderStateSize.toFixed(2)}\n` +
        `Атака ×${battle.attackerSizeModifier.toFixed(2)} · оборона ×${battle.defenderSizeModifier.toFixed(2)}\n` +
        `Underdog +${Math.round(battle.underdogBonus * 100)}% · буфер +${Math.round(battle.defenseBufferPct * 100)}% · усталость −${Math.round(battle.aggressionPenalty * 100)}%`,
        [[{ text: "⚔️ Открыть бой", url: miniAppLink(chatId) }]],
      );
      return true;
    }

    if (command === "улучшить" || command === "upgrade") {
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Улучшать инфраструктуру может только президент или заместитель.");
      const building = BUILDING_ALIASES[String(args[0] || "").toLowerCase()];
      if (!building) throw new Error("Укажите постройку: казначейство, казармы, шахта, нпз, ферма, академия, застава или торговая_палата.");
      const upgrade = await upgradeBuildingAction({ actorRole: snapshot.player.role, stateId: snapshot.state.id, buildingType: building, stateIsFreeport: snapshot.state.isFreeport });
      const buildMinutes = upgrade.finishesAt ? Math.max(1, Math.ceil((new Date(upgrade.finishesAt).getTime() - Date.now()) / 60_000)) : null;
      await send(chatId, `🏗️ Строительство запущено: ${String(args[0])} → ур. ${upgrade.targetLevel}. Ресурсы зарезервированы. ${buildMinutes ? `Осталось примерно ${buildMinutes} мин.` : "Завершение идёт по серверному таймеру."}`, [[{ text: "🏝️ Открыть остров", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (command === "союз" || command === "alliance" || command === "разорватьсоюз") {
      const canDiplomacy = snapshot.player.role === "president" || snapshot.player.dutyRole === "diplomat";
      if (!canDiplomacy) throw new Error("Союзами управляет Президент или Дипломат.");
      const actionRaw = command === "разорватьсоюз" ? "выйти" : String(args[0] || "").toLowerCase();
      const isAction = ["принять", "accept", "отклонить", "reject", "выйти", "leave"].includes(actionRaw);
      let targetRaw = command === "разорватьсоюз" ? args[0] : (isAction ? args[1] : args[0]);
      if (!targetRaw && ["принять", "accept", "отклонить", "reject"].includes(actionRaw)) {
        const pending = snapshot.diplomacy.find((item) => item.status === "alliance_pending" && item.requestedByStateId !== snapshot.state.id);
        if (pending) targetRaw = pending.otherStateId;
      }
      let target: any;
      if (targetRaw && /^[0-9a-f-]{36}$/i.test(String(targetRaw))) {
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from("states").select("id,name,state_username,telegram_chat_id,is_freeport,is_beginner_island").eq("id", String(targetRaw)).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("Государство не найдено.");
        target = data;
      } else {
        if (!targetRaw) throw new Error("Укажите @юз государства. Например: !союз @north_empire");
        target = await resolveStateTarget(String(targetRaw));
      }

      if (["отклонить", "reject"].includes(actionRaw)) {
        await performDiplomacyAction(snapshot.state.id, target.id, "reject_alliance");
        await send(chatId, `Предложение «${target.name}» отклонено.`);
        return true;
      }
      if (["выйти", "leave"].includes(actionRaw)) {
        await performDiplomacyAction(snapshot.state.id, target.id, "break_alliance");
        await send(chatId, `Союз с «${target.name}» разорван.`);
        return true;
      }

      const accepting = ["принять", "accept"].includes(actionRaw);
      if (accepting) {
        const pending = snapshot.diplomacy.find((item) => item.otherStateId === target.id && item.status === "alliance_pending" && item.requestedByStateId !== snapshot.state.id);
        if (!pending) throw new Error("Нет входящего предложения союза от этого государства.");
      }
      const vote = await createStateVote({
        stateId: snapshot.state.id,
        createdByPlayerId: snapshot.player.id,
        kind: "alliance",
        targetStateId: target.id,
        payload: { action: accepting ? "accept" : "propose" },
      });
      await send(chatId,
        `🗳 ГОЛОСОВАНИЕ О СОЮЗЕ\n\n${accepting ? "Заключить" : "Предложить"} союз с «${target.name}»?\nГолосуют граждане государства. Срок: 10 минут.`,
        voteKeyboard(vote.id),
      );
      return true;
    }

    if (command === "разведка") {
      if (!WAR_LEADERS.has(snapshot.player.role)) throw new Error("Разведкой управляет президент или заместитель.");
      const target = await resolveStateTarget(String(args[0] || ""));
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.from("states").select("name,state_username,game_level,rating,army_power,defense_power,reputation,active_player_count,island_integrity").eq("id", target.id).single();
      if (error) throw error;
      await send(chatId, `🔭 РАЗВЕДКА\n\n${data.name}${data.state_username ? ` (@${data.state_username})` : ""}\nУровень ${data.game_level} · ${data.rating} ELO\n⚔️ Армия ≈ ${Math.max(0, Math.round(Number(data.army_power || 0) / 10) * 10)}\n🛡 Оборона ≈ ${Math.max(0, Math.round(Number(data.defense_power || 0) / 10) * 10)}\nРепутация ${data.reputation} · активных ${data.active_player_count}\nПрочность острова ${data.island_integrity}%`);
      return true;
    }

    if (command === "шпион" || command === "spy") {
      if (snapshot.player.dutyRole !== "spy") throw new Error("Команда доступна только участнику со специализацией «Шпион».");
      const target = await resolveStateTarget(String(args[0] || ""));
      if (target.id === snapshot.state.id) throw new Error("Укажите вражеское или нейтральное государство.");
      await send(chatId,
        `🕵️ ШПИОНСКИЙ КВЕСТ\n\nЦель: «${target.name}». Выберите операцию. Один шпионский выход доступен раз в 6 часов.`,
        [[
          { text: "🔭 Разведать", callback_data: `gw:spy:start:${target.id}:recon` },
          { text: "💰 Украсть казну", callback_data: `gw:spy:start:${target.id}:treasury` },
        ]],
      );
      return true;
    }

    if (command === "война" || command === "war") {
      if (snapshot.player.role !== "president") throw new Error("Голосование о начале войны запускает Президент.");
      const targetRaw = String(args[0] || "");
      if (!targetRaw) throw new Error("Формат: !война @north_empire raid");
      const battleType = WAR_TYPES[String(args[1] || "raid").toLowerCase()];
      if (!battleType) throw new Error("Тип войны: raid, siege или territory.");
      const target = await resolveStateTarget(targetRaw);
      const vote = await createStateVote({
        stateId: snapshot.state.id,
        createdByPlayerId: snapshot.player.id,
        kind: "war",
        targetStateId: target.id,
        payload: { battleType },
      });
      await send(chatId,
        `🗳 ГОЛОСОВАНИЕ О ВОЙНЕ\n\nНачать ${typeLabel(battleType)} против «${target.name}»?\nГолосуют граждане государства. Срок: 10 минут. При абсолютном большинстве решение исполняется досрочно.`,
        voteKeyboard(vote.id),
      );
      return true;
    }

    if (command === "поддержать" || command === "support") {
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Союзную поддержку отправляет президент или заместитель.");
      const battleId = String(args[0] || "");
      const rawSide = String(args[1] || "").toLowerCase();
      const side = ["attack", "attacker", "атака"].includes(rawSide) ? "attacker" : ["defense", "defender", "защита"].includes(rawSide) ? "defender" : null;
      if (!battleId || !side) throw new Error("Формат: !поддержать <ID_боя> defense");
      const result: any = await addAllianceBattleSupport(battleId, snapshot.state.id, snapshot.player.id, side);
      await send(chatId, result?.training
        ? `🗺️ Учебная поддержка отправлена: +${Number(result?.power || 0)} силы в оборону. После боя вы получите XP +${Number(result?.xp || 0)}, репутацию +${Number(result?.reputation || 0)} и вклад. Ресурсы Остров новичков не получает.`
        : `🤝 Союзная поддержка отправлена: +${Number(result?.power || 0)} силы на ${side === "defender" ? "оборону" : "атаку"}.`);
      return true;
    }

    if (command === "сдаться" || command === "surrender") {
      if (!WAR_LEADERS.has(snapshot.player.role)) throw new Error("Сдаться может только президент или заместитель.");
      const battleId = String(args[0] || snapshot.activeBattle?.id || "");
      if (!battleId) throw new Error("Активной битвы нет.");
      await surrenderBattle(battleId, snapshot.state.id);
      await send(chatId, "🏳 Государство капитулировало. Бой завершён, применены потери и защитный период восстановления.");
      return true;
    }

    await send(chatId, "❔ КОМАНДА НЕ НАЙДЕНА\n\nПроверьте написание или откройте список команд: !помощь");
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Команда не выполнена.";
    await send(chatId, `⛔ КОМАНДА НЕ ВЫПОЛНЕНА\n\n${messageText}\n\nПодсказка: !помощь`);
    return true;
  }
}

export async function handleGroupCallback(query: any): Promise<boolean> {
  const data = String(query?.data || "");
  if (!["gw:battle:", "gw:support:", "gw:vote:", "gw:spy:", "gw:map:"].some((prefix) => data.startsWith(prefix))) return false;
  const chatId = Number(query?.message?.chat?.id);
  const from = query?.from;
  if (!Number.isSafeInteger(chatId) || !from?.id) return false;

  const answer = async (text: string, showAlert = false) => {
    try {
      await telegramApi("answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 190), show_alert: showAlert });
    } catch {
      // The authoritative game action must survive an expired Telegram callback.
    }
  };

  const sendPrivateOrGroup = async (text: string, keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>) => {
    try {
      await send(Number(from.id), text, keyboard);
      if (Number(from.id) !== chatId) await send(chatId, `🕵️ ${String(from.first_name || "Игрок")}, продолжение задания отправлено в личный чат.`);
    } catch {
      await send(chatId, `${text}\n\nЧтобы получать шпионские задания лично, сначала откройте диалог с ботом и нажмите /start.`, keyboard);
    }
  };

  try {
    const parts = data.split(":");
    const scope = parts[1];
    const action = parts[2];
    const callbackChatType = String(query?.message?.chat?.type || "");
    const stateChatId = ["group", "supergroup"].includes(callbackChatType) ? chatId : null;
    const snapshot = await bootstrapGame(telegramUser(from), stateChatId);

    if (scope === "vote") {
      const voteId = String(parts[3] || "");
      if (!voteId || !["yes", "no"].includes(action)) return false;
      const result: any = await castStateVote(voteId, snapshot.player.id, action === "yes");
      await answer(voteProgressText(result));
      if (result.finalized) {
        if (result.status === "approved") {
          const execution = await executeApprovedStateVote(voteId);
          await announceApprovedVoteExecution(execution);
        } else {
          await send(chatId, `🗳 Голосование завершено: решение отклонено. ${voteProgressText(result)}`);
        }
      }
      return true;
    }

    if (scope === "spy") {
      if (action === "start") {
        const targetStateId = String(parts[3] || "");
        const kind = String(parts[4] || "") as "recon" | "treasury";
        if (!targetStateId || !["recon", "treasury"].includes(kind)) return false;
        const quest: any = await startSpyQuest({ playerId: snapshot.player.id, stateId: snapshot.state.id, targetStateId, kind });
        await answer("Шпион вышел на задание");
        if (kind === "recon") {
          await sendPrivateOrGroup(
            "🕵️ ЭТАП 2/2 · РАЗВЕДКА\n\nКак агент будет собирать сведения?",
            [[
              { text: "🌫 Тихое наблюдение", callback_data: `gw:spy:resolve:${quest.id}:silent` },
              { text: "🎭 Рискованный контакт", callback_data: `gw:spy:resolve:${quest.id}:contact` },
            ]],
          );
        } else {
          await sendPrivateOrGroup(
            "🕵️ ЭТАП 2/2 · КАЗНА\n\nВыберите способ проникновения. Подкуп безопаснее, поддельная накладная даёт больший куш.",
            [[
              { text: "🤝 Подкупить клерка", callback_data: `gw:spy:resolve:${quest.id}:bribe` },
              { text: "📜 Подделать накладную", callback_data: `gw:spy:resolve:${quest.id}:invoice` },
            ]],
          );
        }
        return true;
      }

      if (action === "resolve") {
        const questId = String(parts[3] || "");
        const option = String(parts[4] || "");
        if (!questId || !option) return false;
        const result: any = await resolveSpyQuest(questId, snapshot.player.id, option);
        await answer(result?.success ? "Операция успешна" : "Операция сорвалась");
        if (result?.kind === "recon") {
          await sendPrivateOrGroup(
            `${result.success ? "✅" : "⚠️"} РАЗВЕДКА ЗАВЕРШЕНА\n\n` +
            `⚔️ Армия: ${Number(result.army || 0)}\n🛡 Оборона: ${Number(result.defense || 0)}\n👥 Активных: ${Number(result.activePlayers || 0)}\n🏝 Прочность: ${Number(result.integrity || 0)}%` +
            `${result.credits !== null && result.credits !== undefined ? `\n💰 Казна: ${Number(result.credits).toLocaleString("ru-RU")}` : "\n💰 Казна: данные скрыты"}`,
          );
        } else {
          await sendPrivateOrGroup(result.success
            ? `✅ КАЗНА ВСКРЫТА\n\nВ государственную казну доставлено ${Number(result.stolen || 0).toLocaleString("ru-RU")} кредитов. Вклад шпиона увеличен.`
            : `⚠️ ОПЕРАЦИЯ ПРОВАЛЕНА\n\nКонтрразведка сорвала план. Потеряно ${Number(result.penalty || 0).toLocaleString("ru-RU")} кредитов и немного репутации.`);
        }
        return true;
      }
      return false;
    }

    if (scope === "map") {
      if (action !== "island") return false;
      const stateId = String(parts[3] || "");
      const island = snapshot.islands.find((item) => item.id === stateId);
      if (!island) throw new Error("Остров сейчас не найден на карте.");
      await answer(island.name);
      await send(chatId,
        `🧭 ${island.name}\n\nУр. ${island.level}/${island.maxLevel} · ${island.rating} ELO\n👥 ${island.memberCount.toLocaleString("ru-RU")} участников · активных ${island.activePlayers}\n🛡 Прочность ${island.integrity}%\n\nОстров закреплён в радаре Mini App и доступен для выбора независимо от расстояния.`,
        [[{ text: "🗺 Открыть карту", url: miniAppLink(chatId) }]],
      );
      return true;
    }

    const battleId = String(parts[3] || "");
    if (!battleId) return false;
    if (!LEADERS.has(snapshot.player.role)) throw new Error("Это действие доступно только президенту, заместителю или куратору Острова новичков.");

    if (scope === "support") {
      if (action === "skip") {
        await answer("Запрос пропущен");
        return true;
      }
      const side = action === "attacker" ? "attacker" : action === "defender" ? "defender" : null;
      if (!side) return false;
      const result: any = await addAllianceBattleSupport(battleId, snapshot.state.id, snapshot.player.id, side);
      await answer(`Поддержка +${Number(result?.power || 0)}`);
      await send(chatId, result?.training
        ? `🗺️ Учебная поддержка принята: +${Number(result?.power || 0)} к обороне. После боя Остров новичков получит опыт, репутацию и вклад, но не ресурсы.`
        : `🤝 Поддержка принята: +${Number(result?.power || 0)} силы на ${side === "defender" ? "оборону" : "атаку"}.`);
      return true;
    }

    const supabase = getSupabaseAdmin();
    const { data: battle, error } = await supabase
      .from("battles")
      .select("id,status,attacker_state_id,defender_state_id,attacker:states!battles_attacker_state_id_fkey(name),defender:states!battles_defender_state_id_fkey(name)")
      .eq("id", battleId)
      .maybeSingle();
    if (error) throw error;
    if (!battle || !["scheduled", "active"].includes(String(battle.status))) throw new Error("Бой уже завершён.");
    const isAttacker = String(battle.attacker_state_id) === snapshot.state.id;
    const isDefender = String(battle.defender_state_id) === snapshot.state.id;
    if (!isAttacker && !isDefender) throw new Error("Ваше государство не участвует в этом бою.");

    if (action === "support") {
      const allies = await getAlliedStateChats(snapshot.state.id);
      const requestedSide = isAttacker ? "attacker" : "defender";
      const enemy: any = isAttacker ? battle.defender : battle.attacker;
      await Promise.all(allies.map((ally: { id: string; name: string; telegramChatId: number }) => send(
        ally.telegramChatId,
        `🤝 Союзный запрос: ${snapshot.state.name} просит помощи в бою против ${String(enemy?.name || "противника")}.\nПоддержите ${requestedSide === "attacker" ? "атаку" : "оборону"}:`,
        [
          [requestedSide === "attacker"
            ? { text: "⚔️ Помочь атакой", callback_data: `gw:support:attacker:${battleId}` }
            : { text: "🛡️ Помочь защитой", callback_data: `gw:support:defender:${battleId}` }],
          [{ text: "Пропустить", callback_data: `gw:support:skip:${battleId}` }],
          [{ text: "Открыть бой", url: miniAppLink(ally.telegramChatId) }],
        ],
      )));
      await answer(allies.length ? `Запрос отправлен союзникам: ${allies.length}` : "Активных союзников нет", !allies.length);
      return true;
    }

    if (action === "surrender") {
      if (!WAR_LEADERS.has(snapshot.player.role)) throw new Error("Сдаться может только президент или заместитель.");
      if (!isDefender) throw new Error("Капитуляцию через эту кнопку подтверждает защищающаяся сторона.");
      await surrenderBattle(battleId, snapshot.state.id);
      await answer("Капитуляция подтверждена");
      await send(chatId, "🏳 Государство капитулировало. Бой завершён, включён период восстановления.");
      return true;
    }

    return false;
  } catch (error) {
    await answer(error instanceof Error ? error.message : "Действие не выполнено.", true);
    return true;
  }
}

