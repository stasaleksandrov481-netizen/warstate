import { getBattleView } from "@/lib/battle";
import { performDiplomacyAction } from "@/lib/diplomacy";
import { bootstrapGame, tickState, upgradeBuilding } from "@/lib/game";
import { createIslandBattle } from "@/lib/islands";
import { miniAppLink, telegramApi } from "@/lib/telegram-bot";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { BuildingType } from "@/lib/types";
import type { TelegramUser } from "@/lib/telegram";

const LEADERS = new Set(["president", "minister"]);
const COMMANDERS = new Set(["president", "minister", "general"]);

const BUILDING_ALIASES: Record<string, BuildingType> = {
  hq: "hq",
  штаб: "hq",
  barracks: "barracks",
  казармы: "barracks",
  казарма: "barracks",
  mine: "mine",
  шахта: "mine",
  refinery: "refinery",
  нпз: "refinery",
  farm: "farm",
  ферма: "farm",
  lab: "lab",
  лаборатория: "lab",
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
  return `💰 ${t.credits.toLocaleString("ru-RU")} · ⚙️ ${t.steel.toLocaleString("ru-RU")} · ⛽ ${t.fuel.toLocaleString("ru-RU")} · 🌾 ${t.food.toLocaleString("ru-RU")} · 🔬 ${t.tech.toLocaleString("ru-RU")}`;
}

async function targetStateByChatId(chatId: number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("states")
    .select("id,name,telegram_chat_id,is_freeport")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Государство цели ещё не создано. В целевой группе администратор должен сначала открыть игру через /gw.");
  if (data.is_freeport) throw new Error("Freeport — нейтральная территория.");
  return data;
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
        "🧭 КОМАНДЫ ГОСУДАРСТВА\n\n" +
        "!статус — состояние острова\n" +
        "!ресурсы — казна и производство\n" +
        "!активность — ежедневные задания\n" +
        "!улучшить <штаб|казармы|шахта|нпз|ферма|лаборатория>\n" +
        "!союз <ID_чата> — предложить союз\n" +
        "!война <ID_чата> — начать морскую операцию\n\n" +
        "Все действия проверяют реальные права и членство в Telegram-группе. Mini App дублирует эти же возможности."
      );
      return true;
    }

    const snapshot = await bootstrapGame(telegramUser(from), chatId);

    if (command === "статус" || command === "status") {
      const s = snapshot.state;
      const shield = s.shieldUntil && new Date(s.shieldUntil).getTime() > Date.now() ? " · 🛡️ щит активен" : "";
      await send(chatId,
        `🏝️ ${s.name}\n` +
        `ELO ${s.rating} · место #${s.seasonRank || "—"}\n` +
        `👥 ${s.memberCount.toLocaleString("ru-RU")} · прочность ${s.islandIntegrity}%${shield}\n` +
        `⚔️ ${s.islandWins} побед · ${s.islandLosses} поражений · серия ${s.winStreak}\n\n` +
        resourceLine(snapshot),
        [[{ text: "🌊 Открыть остров", url: miniAppLink(chatId) }]],
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

    if (command === "активность" || command === "activity") {
      const lines = snapshot.dailyMissions.map((mission) => {
        const done = mission.progress >= mission.target;
        return `${done ? "✅" : "▫️"} ${mission.title} ${Math.min(mission.progress, mission.target)}/${mission.target} · +${mission.rewardXp} XP`;
      });
      await send(chatId,
        `🎯 АКТИВНОСТИ НА СЕГОДНЯ\n\n${lines.length ? lines.join("\n") : "На сегодня заданий нет."}\n\nОткрой Mini App, чтобы забрать готовые награды.`,
        [[{ text: "🎯 Открыть задания", url: miniAppLink(chatId) }]],
      );
      return true;
    }

    if (command === "улучшить" || command === "upgrade") {
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Улучшать инфраструктуру может только президент или заместитель.");
      const building = BUILDING_ALIASES[String(args[0] || "").toLowerCase()];
      if (!building) throw new Error("Укажите постройку: штаб, казармы, шахта, нпз, ферма или лаборатория.");
      await upgradeBuilding(snapshot.state.id, building);
      await send(chatId, `🏗️ Улучшение запущено: ${String(args[0])}. Казна и уровень обновлены.`, [[{ text: "🏝️ Открыть остров", url: miniAppLink(chatId) }]]);
      return true;
    }

    if (command === "союз" || command === "alliance") {
      if (!LEADERS.has(snapshot.player.role)) throw new Error("Предлагать союзы может только президент или заместитель.");
      const targetChatId = parseChatId(args[0]);
      if (!targetChatId) throw new Error("Формат: !союз -1001234567890");
      const target = await targetStateByChatId(targetChatId);
      await performDiplomacyAction(snapshot.state.id, target.id, "propose_alliance");
      await send(chatId, `🤝 Предложение союза отправлено государству «${target.name}».`);
      await send(Number(target.telegram_chat_id), `🤝 ${snapshot.state.name} предлагает союз. Откройте Mini App, чтобы принять или отклонить предложение.`, [[{ text: "🤝 Дипломатия", url: miniAppLink(Number(target.telegram_chat_id)) }]]);
      return true;
    }

    if (command === "война" || command === "war") {
      if (!COMMANDERS.has(snapshot.player.role)) throw new Error("Начинать войну может президент, заместитель или генерал.");
      const targetChatId = parseChatId(args[0]);
      if (!targetChatId) throw new Error("Формат: !война -1001234567890");
      const target = await targetStateByChatId(targetChatId);
      const battleId = await createIslandBattle(snapshot.state.id, target.id);
      const battle = await getBattleView(battleId, snapshot.player.id);
      const text = `🚨 МОРСКАЯ ОПЕРАЦИЯ\n\n${snapshot.state.name} атакует ${target.name}.\nБой длится 3 минуты. Захватывайте точки A/B/C.\n\nБаланс размера уже применён: большое государство не получает автоматическую победу.`;
      await Promise.all([
        send(chatId, text, [[{ text: "⚔️ Войти в бой", url: miniAppLink(chatId) }]]),
        send(Number(target.telegram_chat_id), text, [[{ text: "🛡️ Организовать оборону", url: miniAppLink(Number(target.telegram_chat_id)) }]]),
      ]);
      void battle;
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
