import { getBattleView } from "@/lib/battle";
import { getAlliedStateChats, performDiplomacyAction } from "@/lib/diplomacy";
import { bootstrapGame, tickState, upgradeBuilding } from "@/lib/game";
import { createIslandBattle } from "@/lib/islands";
import { addAllianceBattleSupport, completeDailyActivity, surrenderBattle } from "@/lib/strategy";
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

function parseChatId(raw?: string) {
  if (!raw) return null;
  const value = Number(raw.replace(/[^0-9-]/g, ""));
  return Number.isSafeInteger(value) && value !== 0 ? value : null;
}

function resourceLine(snapshot: Awaited<ReturnType<typeof bootstrapGame>>) {
  const t = snapshot.state.treasury;
  return `💰 ${t.credits.toLocaleString("ru-RU")} · ⚙️ ${t.steel.toLocaleString("ru-RU")} · ⛽ ${t.fuel.toLocaleString("ru-RU")} · 🌾 ${t.food.toLocaleString("ru-RU")} · 🔬 ${t.tech.toLocaleString("ru-RU")} · 🏛 ${snapshot.state.influence.toLocaleString("ru-RU")}`;
}

async function targetStateByChatId(chatId: number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select("id,name,telegram_chat_id,is_freeport,is_beginner_island")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Государство цели ещё не создано. В целевой группе администратор должен сначала открыть игру через /gw.");
  if (data.is_freeport) throw new Error("Freeport — нейтральная территория.");
  return data;
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
        "!статус — государство и баланс\n" +
        "!ресурсы — казна и производство\n" +
        "!профиль — роль, опыт и вклад\n" +
        "!вклад — ваш вклад и последние начисления\n" +
        "!государства — список государств\n" +
        "!активность — 3–4 ежедневных активности с выбором\n" +
        "!активность <ключ> <вариант> — выполнить выбор\n" +
        "!бой / !оборона — текущая битва и модификаторы\n" +
        "!улучшить <казначейство|казармы|шахта|нпз|ферма|академия|застава|торговая_палата>\n" +
        "!союз <ID_чата> — предложить союз\n" +
        "!союз принять <ID_чата> / !союз отклонить <ID_чата>\n" +
        "!война <ID_чата> <raid|siege|territory>\n" +
        "!поддержать <ID_боя> <attack|defense>\n" +
        "!сдаться — завершить текущий бой капитуляцией\n\n" +
        "Mini App использует те же серверные проверки и не даёт дополнительных прав."
      );
      return true;
    }

    const snapshot = await bootstrapGame(telegramUser(from), chatId);

    if (command === "статус" || command === "status") {
      const s = snapshot.state;
      const shield = s.shieldUntil && new Date(s.shieldUntil).getTime() > Date.now() ? " · 🛡️ щит активен" : "";
      const beginner = s.isBeginnerIsland ? "\n🧭 Остров новичков · максимум ур. 5 · атаки запрещены" : "";
      await send(chatId,
        `🏝️ ${s.name}\n` +
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
      const roleLabel = snapshot.player.role === "president" ? "Президент"
        : ["minister", "deputy"].includes(snapshot.player.role) ? "Заместитель"
        : snapshot.player.role === "curator" ? "Куратор"
        : snapshot.player.role === "general" ? "Генерал" : "Участник";
      await send(chatId,
        `👤 ${snapshot.player.displayName}\n\nРоль: ${roleLabel}\nГосударство: ${snapshot.state.name}\nXP: ${snapshot.player.xp.toLocaleString("ru-RU")}\nВклад: ${snapshot.player.contribution.toLocaleString("ru-RU")}`
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
      const { data, error } = await supabase.from("states").select("telegram_chat_id,name,game_level,rating,active_player_count,is_beginner_island").eq("is_freeport", false).order("rating", { ascending: false }).limit(15);
      if (error) throw error;
      const lines = (data || []).map((state: any, index: number) => `${index + 1}. ${state.is_beginner_island ? "🧭 " : ""}${state.name} · ур.${state.game_level} · ${state.rating} ELO · ${state.active_player_count} активных · ID ${state.telegram_chat_id}`);
      await send(chatId, `🌍 ГОСУДАРСТВА\n\n${lines.join("\n") || "Других государств пока нет."}`);
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
      const upgrade = await upgradeBuilding(snapshot.state.id, building);
      const buildMinutes = upgrade.finishesAt ? Math.max(1, Math.ceil((new Date(upgrade.finishesAt).getTime() - Date.now()) / 60_000)) : null;
      await send(chatId, `🏗️ Строительство запущено: ${String(args[0])} → ур. ${upgrade.targetLevel}. Ресурсы зарезервированы. ${buildMinutes ? `Осталось примерно ${buildMinutes} мин.` : "Завершение идёт по серверному таймеру."}`, [[{ text: "🏝️ Открыть остров", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (command === "союз" || command === "alliance") {
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Дипломатией управляет президент или заместитель.");
      const actionRaw = String(args[0] || "").toLowerCase();
      const isAction = ["принять", "accept", "отклонить", "reject", "выйти", "leave"].includes(actionRaw);
      const targetChatId = parseChatId(isAction ? args[1] : args[0]);
      if (!targetChatId) throw new Error("Формат: !союз -1001234567890 или !союз принять -1001234567890");
      const target = await targetStateByChatId(targetChatId);
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
        await send(Number(target.telegram_chat_id), `🤝 ${snapshot.state.name} предлагает союз. Команда: !союз принять ${chatId}`, [[{ text: "🤝 Дипломатия", url: miniAppLink(Number(target.telegram_chat_id)) }]]);
      }
      return true;
    }

    if (command === "война" || command === "war") {
      if (!WAR_LEADERS.has(snapshot.player.role)) throw new Error("Начинать войну может только президент или заместитель.");
      const targetChatId = parseChatId(args[0]);
      if (!targetChatId) throw new Error("Формат: !война -1001234567890 raid");
      const battleType = WAR_TYPES[String(args[1] || "raid").toLowerCase()];
      if (!battleType) throw new Error("Тип войны: raid, siege или territory.");
      const target = await targetStateByChatId(targetChatId);
      const battleId = await createIslandBattle(snapshot.state.id, target.id, battleType);
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
