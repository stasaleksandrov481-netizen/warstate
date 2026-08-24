import { getBattleView } from "@/lib/battle";
import { getAlliedStateChats, performDiplomacyAction } from "@/lib/diplomacy";
import { bootstrapGame, tickState } from "@/lib/game";
import { startWarAction, upgradeBuildingAction } from "@/lib/actions";
import { addAllianceBattleSupport, completeDailyActivity, surrenderBattle } from "@/lib/strategy";
import { appointPresident, openGovernmentElection, removePresident, renameState, resolveStateTarget, searchStates, setDeputy, setStateUsername, voteForUsername } from "@/lib/government";
import { claimDailyMission } from "@/lib/missions";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { BuildingType, WarType } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";

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

async function send(chatId: number, text: string, keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>) {
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

function typeLabel(type: WarType) {
  return type === "siege" ? "осада" : type === "territory" ? "спор за территорию" : "рейд";
}

export async function handleGroupTextCommand(message: any): Promise<boolean> {
  const text = String(message?.text || "").trim();
  if (!text.startsWith("!")) return false;
  const chatId = Number(message?.chat?.id);
  const from = message?.from;
  if (!Number.isSafeInteger(chatId) || !from?.id) return false;

  const [rawCommand, ...args] = text.slice(1).trim().split(/\s+/);
  const command = rawCommand.toLowerCase();

  try {
    if (["help", "помощь", "команды"].includes(command)) {
      await send(chatId,
        "🧭 КОМАНДЫ WARSTATE\n\n" +
        "ИНФОРМАЦИЯ\n" +
        "!государство · !статус · !ресурсы · !рейтинг · !карта · !альянсы · !профиль\n\n" +
        "ПОЛИТИКА\n" +
        "!президент · !замы · !выборы · !голосовать @username\n" +
        "!назначитьпрезидента @username · !снятьпрезидента\n" +
        "!назначитьзама @username · !снятьзама @username\n" +
        "!создатьюз north_empire · !юз new_handle · !название Новое Государство · !найти north\n\n" +
        "ЭКОНОМИКА\n" +
        "!казна · !постройки · !улучшить <постройка> · !налоги\n\n" +
        "ВОЙНА\n" +
        "!война @state <raid|siege|territory> · !бой · !оборона · !разведка @state · !сдаться\n\n" +
        "СОЮЗЫ\n" +
        "!союз @state · !союз принять [@state] · !союз отклонить [@state] · !разорватьсоюз @state\n\n" +
        "АКТИВНОСТИ\n" +
        "!активность · !миссия · !награда\n\n" +
        "Обычное сообщение: +2 XP игроку и +1 вклад государству, максимум раз в минуту. Mini App использует те же игровые обработчики."
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
        [[{ text: "🏛 Открыть государство", url: miniAppLink(chatId) }]],
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

    if (command === "выборы") {
      if (!snapshot.government.canFounderManage) throw new Error("Внеочередные выборы запускает только Основатель.");
      const electionId = await openGovernmentElection(snapshot.state.id, snapshot.player.id);
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
      await send(chatId, "🗺 Карта государств открывается в Mini App.", [[{ text: "🗺 Открыть карту", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (command === "альянсы") {
      const allies = snapshot.diplomacy.filter((item) => item.status === "allied");
      await send(chatId, `🤝 СОЮЗЫ\n\n${allies.length ? allies.map((item, i) => `${i + 1}. ${item.otherStateName}`).join("\n") : "Активных союзов нет."}`);
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
        `👤 ${snapshot.player.displayName}\n\nРоль: ${roleLabel}\nУровень: ${snapshot.player.level}\nОпыт: ${snapshot.player.xp.toLocaleString("ru-RU")} XP\nВклад: ${snapshot.player.contribution.toLocaleString("ru-RU")}\nПобеды: ${wins}\nЗащиты: ${defenses}\nГосударство: ${snapshot.state.name}${snapshot.state.stateUsername ? ` (@${snapshot.state.stateUsername})` : ""}`
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
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Дипломатией управляет президент или заместитель.");
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
      if (["принять", "accept"].includes(actionRaw)) {
        await performDiplomacyAction(snapshot.state.id, target.id, "accept_alliance");
        await send(chatId, `🤝 Союз с «${target.name}» заключён.`);
      } else if (["отклонить", "reject"].includes(actionRaw)) {
        await performDiplomacyAction(snapshot.state.id, target.id, "reject_alliance");
        await send(chatId, `Предложение «${target.name}» отклонено.`);
      } else if (["выйти", "leave"].includes(actionRaw)) {
        await performDiplomacyAction(snapshot.state.id, target.id, "break_alliance");
        await send(chatId, `Союз с «${target.name}» разорван.`);
      } else {
        await performDiplomacyAction(snapshot.state.id, target.id, "propose_alliance");
        await send(chatId, `🤝 Предложение союза отправлено государству «${target.name}».`);
        if (target.telegram_chat_id) await send(Number(target.telegram_chat_id), `🤝 ${snapshot.state.name} предлагает союз. Команда: !союз принять @${snapshot.state.stateUsername || "ваш_союзник"}`, [[{ text: "🤝 Дипломатия", url: miniAppLink(Number(target.telegram_chat_id)) }]]);
      }
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

    if (command === "война" || command === "war") {
      if (!WAR_LEADERS.has(snapshot.player.role)) throw new Error("Начинать войну может только президент или заместитель.");
      const targetRaw = String(args[0] || "");
      if (!targetRaw) throw new Error("Формат: !война @north_empire raid");
      const battleType = WAR_TYPES[String(args[1] || "raid").toLowerCase()];
      if (!battleType) throw new Error("Тип войны: raid, siege или territory.");
      const target = await resolveStateTarget(targetRaw);
      const battleId = await startWarAction({ actorRole: snapshot.player.role, attackerStateId: snapshot.state.id, defenderStateId: target.id, battleType, attackerIsFreeport: snapshot.state.isFreeport });
      const battle = await getBattleView(battleId, snapshot.player.id);
      const text = `🚨 ${typeLabel(battleType).toUpperCase()}\n\n${snapshot.state.name} атакует ${target.name}.\nРазмер, оборонительный буфер, усталость и случайный фактор уже зафиксированы. Союзники могут поддержать бой командой !поддержать ${battleId} defense/attack.`;
      await Promise.all([
        send(chatId, text, [[{ text: "⚔️ Войти в бой", url: miniAppLink(chatId) }]]),
        send(Number(target.telegram_chat_id), text, [
          [{ text: "🛡️ Организовать оборону", url: miniAppLink(Number(target.telegram_chat_id)) }],
          [{ text: "🤝 Запросить союзную помощь", callback_data: `gw:battle:support:${battleId}` }],
          [{ text: "🏳 Сдаться", callback_data: `gw:battle:surrender:${battleId}` }],
        ]),
      ]);
      const [ourAllies, theirAllies] = await Promise.all([getAlliedStateChats(snapshot.state.id), getAlliedStateChats(target.id)]);
      await Promise.all([
        ...ourAllies.map((ally: { id: string; name: string; telegramChatId: number }) => send(ally.telegramChatId, `🤝 Союзный запрос: ${snapshot.state.name} просит помощи в бою против ${target.name}.\nВыберите действие:`, [
          [{ text: "⚔️ Помочь атакой", callback_data: `gw:support:attacker:${battleId}` }],
          [{ text: "Пропустить", callback_data: `gw:support:skip:${battleId}` }],
          [{ text: "Открыть бой", url: miniAppLink(ally.telegramChatId) }],
        ])),
        ...theirAllies.map((ally: { id: string; name: string; telegramChatId: number }) => send(ally.telegramChatId, `🤝 Союзный запрос: ${target.name} просит помощи в бою против ${snapshot.state.name}.\nВыберите действие:`, [
          [{ text: "🛡️ Помочь защитой", callback_data: `gw:support:defender:${battleId}` }],
          [{ text: "Пропустить", callback_data: `gw:support:skip:${battleId}` }],
          [{ text: "Открыть бой", url: miniAppLink(ally.telegramChatId) }],
        ])),
      ]);
      void battle;
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

    await send(chatId, "Неизвестная команда. Напишите !помощь.");
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Команда не выполнена.";
    await send(chatId, `⛔ ${messageText}`);
    return true;
  }
}

export async function handleGroupCallback(query: any): Promise<boolean> {
  const data = String(query?.data || "");
  if (!data.startsWith("gw:battle:") && !data.startsWith("gw:support:")) return false;
  const chatId = Number(query?.message?.chat?.id);
  const from = query?.from;
  if (!Number.isSafeInteger(chatId) || !from?.id) return false;

  const [, scope, action, battleId] = data.split(":");
  if (!scope || !action || !battleId) return false;

  const answer = async (text: string, showAlert = false) => {
    try {
      await telegramApi("answerCallbackQuery", { callback_query_id: query.id, text, show_alert: showAlert });
    } catch {
      // The action itself is authoritative; an expired Telegram callback must not roll it back.
    }
  };

  try {
    const snapshot = await bootstrapGame(telegramUser(from), chatId);
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
        `🤝 Союзный запрос: ${snapshot.state.name} просит помощи в бою против ${String(enemy?.name || "противника")}.
Поддержите ${requestedSide === "attacker" ? "атаку" : "оборону"}:`,
        [
          [requestedSide === "attacker"
            ? { text: "⚔️ Помочь атакой", callback_data: `gw:support:attacker:${battleId}` }
            : { text: "🛡️ Помочь защитой", callback_data: `gw:support:defender:${battleId}` }],
          [{ text: "Пропустить", callback_data: `gw:support:skip:${battleId}` }],
          [{ text: "Открыть бой", url: miniAppLink(ally.telegramChatId) }],
        ],
      )));
      await answer(allies.length ? `Запрос отправлен союзникам: ${allies.length} · рекомендуемая сторона: ${requestedSide === "attacker" ? "атака" : "оборона"}` : "Активных союзников нет", !allies.length);
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
    await answer(error instanceof Error ? error.message.slice(0, 180) : "Действие не выполнено.", true);
    return true;
  }
}
