"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import {
  createDemoSnapshot,
  demoBattleAction,
  demoClaimMission,
  demoCustomizeState,
  demoDiplomacyAction,
  demoIslandAttack,
  demoPoliticsAction,
  demoProgressMission,
  demoRepairIsland,
  demoUpgrade,
} from "@/lib/demo";
import type {
  BattleClass,
  BattleView,
  BuildingType,
  DiplomacyAction,
  DiplomacyRelationView,
  GameSnapshot,
  IslandView,
  StateView,
} from "@/lib/types";
import { IslandMap } from "@/components/game/island-map";
import { IslandHome } from "@/components/game/island-home";
import { IslandRanking } from "@/components/game/island-ranking";
import { IslandAlliances } from "@/components/game/island-alliances";

const BattleScreen = dynamic(() => import("@/components/game/battle-screen").then((m) => m.BattleScreen), { ssr: false, loading: () => <SceneLoading label="Поднимаем фронт…" /> });
const StateViewPanel = dynamic(() => import("@/components/game/state-view").then((m) => m.StateViewPanel), { ssr: false, loading: () => <SceneLoading label="Открываем профиль…" /> });

type View = "map" | "island" | "battle" | "rating" | "alliances" | "profile";

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string } };
  ready?: () => void;
  expand?: () => void;
  HapticFeedback?: { impactOccurred?: (style: string) => void; notificationOccurred?: (type: string) => void };
};

function tg(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return (window as any).Telegram?.WebApp || null;
}

function startParam() {
  const telegram = tg();
  return (
    telegram?.initDataUnsafe?.start_param ||
    new URLSearchParams(window.location.search).get("startapp") ||
    new URLSearchParams(window.location.search).get("tgWebAppStartParam")
  );
}

function mergeIslandLists(current: IslandView[] = [], incoming: IslandView[] = [], max = 700) {
  const incomingIds = new Set(incoming.map((item) => item.id));
  const merged = [...incoming, ...current.filter((item) => !incomingIds.has(item.id))];
  const mine = merged.find((item) => item.isMine);
  const rest = merged.filter((item) => !item.isMine);
  return mine ? [mine, ...rest].slice(0, max) : rest.slice(0, max);
}

async function api<T>(path: string, initData: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": initData,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

const NAV: Array<{ key: View; label: string }> = [
  { key: "map", label: "Карта" },
  { key: "island", label: "Остров" },
  { key: "battle", label: "Битвы" },
  { key: "rating", label: "Рейтинг" },
  { key: "alliances", label: "Союзы" },
  { key: "profile", label: "Профиль" },
];

export default function GameApp() {
  const [view, setView] = useState<View>("map");
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [selectedIsland, setSelectedIsland] = useState<IslandView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const refreshLiveTimer = useRef<number | null>(null);
  const refreshBattleTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const exploreTimer = useRef<number | null>(null);
  const lastExploreRef = useRef<{ x: number; y: number; radius: number; at: number } | null>(null);
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const telegram = typeof window !== "undefined" ? tg() : null;
  const initData = telegram?.initData || "";

  const acceptSnapshot = useCallback((fresh: GameSnapshot) => {
    setSnapshot((current) => ({
      ...fresh,
      islands: mergeIslandLists(current?.islands || [], fresh.islands || []),
    }));
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const app = tg();
      app?.ready?.();
      app?.expand?.();
      if (demo || !app?.initData) {
        const fresh = createDemoSnapshot();
        const saved = localStorage.getItem("groupwars-demo-v11-islands");
        if (!saved) setSnapshot(fresh);
        else {
          const parsed = JSON.parse(saved) as Partial<GameSnapshot>;
          setSnapshot({
            ...fresh,
            ...parsed,
            state: { ...fresh.state, ...(parsed.state || {}) },
            player: { ...fresh.player, ...(parsed.player || {}) },
            islands: parsed.islands || fresh.islands,
            dailyMissions: parsed.dailyMissions || fresh.dailyMissions,
          });
        }
      } else {
        const data = await api<GameSnapshot>("/api/game/bootstrap", app.initData, {
          method: "POST",
          body: JSON.stringify({ startParam: startParam() }),
        });
        setSnapshot(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось открыть игру");
    } finally {
      setLoading(false);
    }
  }, [demo]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (refreshLiveTimer.current) window.clearTimeout(refreshLiveTimer.current);
    if (refreshBattleTimer.current) window.clearTimeout(refreshBattleTimer.current);
    if (exploreTimer.current) window.clearTimeout(exploreTimer.current);
  }, []);
  useEffect(() => {
    if (snapshot?.mode === "demo") localStorage.setItem("groupwars-demo-v11-islands", JSON.stringify(snapshot));
  }, [snapshot]);

  const refreshLive = useCallback(async () => {
    if (!snapshot || snapshot.mode !== "live" || !initData) return;
    const fresh = await api<GameSnapshot>(`/api/game/state?stateId=${snapshot.state.id}`, initData);
    acceptSnapshot(fresh);
  }, [snapshot?.state.id, snapshot?.mode, initData, acceptSnapshot]);

  const scheduleRefreshLive = useCallback(() => {
    if (refreshLiveTimer.current) window.clearTimeout(refreshLiveTimer.current);
    refreshLiveTimer.current = window.setTimeout(() => { void refreshLive(); }, 220);
  }, [refreshLive]);

  const refreshBattle = useCallback(async () => {
    const battleId = snapshot?.activeBattle?.id;
    if (!battleId || snapshot?.mode !== "live" || !initData) return;
    try {
      const battle = await api<BattleView>(`/api/game/battle?battleId=${battleId}`, initData);
      setSnapshot((current) => current ? { ...current, activeBattle: battle } : current);
      if (battle.status === "resolved") window.setTimeout(() => scheduleRefreshLive(), 500);
    } catch { /* realtime can race with resolution */ }
  }, [snapshot?.activeBattle?.id, snapshot?.mode, initData, scheduleRefreshLive]);

  const scheduleRefreshBattle = useCallback(() => {
    if (refreshBattleTimer.current) window.clearTimeout(refreshBattleTimer.current);
    refreshBattleTimer.current = window.setTimeout(() => { void refreshBattle(); }, 120);
  }, [refreshBattle]);

  useEffect(() => {
    if (!snapshot || snapshot.mode !== "live") return;
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    const channel = supabase
      .channel(`island-world-${snapshot.state.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "states", filter: `id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .on("postgres_changes", { event: "*", schema: "public", table: "diplomacy_relations" }, scheduleRefreshLive)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "world_events" }, scheduleRefreshLive)
      .on("postgres_changes", { event: "*", schema: "public", table: "state_elections", filter: `state_id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [snapshot?.state.id, snapshot?.mode, scheduleRefreshLive]);

  useEffect(() => {
    const battleId = snapshot?.activeBattle?.id;
    if (!battleId || snapshot?.mode !== "live") return;
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    const channel = supabase
      .channel(`battle-${battleId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "battles", filter: `id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_players", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "battle_events", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_orders", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .subscribe();
    const timer = window.setInterval(refreshBattle, 5000);
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [snapshot?.activeBattle?.id, snapshot?.mode, scheduleRefreshBattle, refreshBattle]);

  const exploreIslands = useCallback((x: number, y: number, radius: number) => {
    if (!snapshot || snapshot.mode !== "live" || !initData) return;
    const previous = lastExploreRef.current;
    const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : Number.POSITIVE_INFINITY;
    if (previous && Date.now() - previous.at < 4500 && distance < Math.min(radius, previous.radius) * 0.18 && radius <= previous.radius * 1.12) return;
    lastExploreRef.current = { x, y, radius, at: Date.now() };
    if (exploreTimer.current) window.clearTimeout(exploreTimer.current);
    exploreTimer.current = window.setTimeout(async () => {
      try {
        const data = await api<{ islands: IslandView[] }>(`/api/game/islands?stateId=${snapshot.state.id}&x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}&radius=${Math.round(radius)}`, initData);
        setSnapshot((current) => current ? { ...current, islands: mergeIslandLists(current.islands, data.islands) } : current);
        setSelectedIsland((current) => current ? data.islands.find((item) => item.id === current.id) || current : null);
      } catch { /* blank water is better than noisy errors while panning */ }
    }, 220);
  }, [snapshot?.state.id, snapshot?.mode, initData]);

  async function upgrade(type: BuildingType) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        setSnapshot(demoUpgrade(snapshot, type));
        tg()?.HapticFeedback?.impactOccurred?.("medium");
        notify("Инфраструктура улучшена");
        return;
      }
      const fresh = await api<GameSnapshot>("/api/game/upgrade", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, buildingType: type }),
      });
      acceptSnapshot(fresh);
      notify("Инфраструктура улучшена");
    } catch (e) { notify(e instanceof Error ? e.message : "Ошибка улучшения"); }
  }

  async function repairOwnIsland(amount = 25) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        const before = snapshot.state.islandIntegrity;
        const next = demoRepairIsland(snapshot, amount);
        if (next.state.islandIntegrity === before) return notify("Ремонт сейчас недоступен или не хватает ресурсов");
        setSnapshot(next);
        notify(`Прочность восстановлена до ${next.state.islandIntegrity}%`);
        return;
      }
      const result = await api<{ snapshot: GameSnapshot; repair: { integrity: number; repaired: number; creditsCost: number; steelCost: number } }>("/api/game/island/repair", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, amount }),
      });
      acceptSnapshot(result.snapshot);
      notify(`+${result.repair.repaired}% прочности · ${result.repair.integrity}%`);
    } catch (e) { notify(e instanceof Error ? e.message : "Ремонт не удался"); }
  }

  async function attackIsland(island: IslandView) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        const result = demoIslandAttack(snapshot, island.id);
        if (!result.result) return notify("Сейчас этот остров атаковать нельзя");
        setSnapshot(result.snapshot);
        setSelectedIsland(null);
        setView("battle");
        notify("Флот вышел к острову. Битва началась.");
        return;
      }
      const result = await api<{ snapshot: GameSnapshot; battle: BattleView }>("/api/game/island/attack", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, targetStateId: island.id }),
      });
      acceptSnapshot({ ...result.snapshot, activeBattle: result.battle });
      setSelectedIsland(null);
      setView("battle");
      notify("Атака началась. Зови людей из чата.");
    } catch (e) { notify(e instanceof Error ? e.message : "Атака не удалась"); }
  }

  async function joinBattle(klass: BattleClass) {
    if (!snapshot?.activeBattle) return;
    if (snapshot.mode === "demo") {
      setSnapshot((current) => {
        if (!current?.activeBattle) return current;
        const joined = { ...current, activeBattle: demoBattleAction(current.activeBattle, "join", { class: klass }, current.player) };
        return demoProgressMission(joined, "join_battle");
      });
      return;
    }
    try {
      const battle = await api<BattleView>("/api/game/battle/join", initData, { method: "POST", body: JSON.stringify({ battleId: snapshot.activeBattle.id, class: klass }) });
      setSnapshot({ ...snapshot, activeBattle: battle });
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось войти в бой"); }
  }

  async function actBattle(action: string, payload: Record<string, unknown> = {}) {
    if (!snapshot?.activeBattle) return;
    if (snapshot.mode === "demo") {
      const battle = demoBattleAction(snapshot.activeBattle, action, payload, snapshot.player);
      let next: GameSnapshot = { ...snapshot, activeBattle: battle };
      if (["move", "capture", "fire", "heal", "fortify"].includes(action)) next = demoProgressMission(next, "battle_action");
      if (action === "capture") next = demoProgressMission(next, "capture_point");
      setSnapshot(next);
      return;
    }
    try {
      const battle = await api<BattleView>("/api/game/battle/action", initData, { method: "POST", body: JSON.stringify({ battleId: snapshot.activeBattle.id, action, ...payload }) });
      setSnapshot({ ...snapshot, activeBattle: battle });
    } catch (e) { notify(e instanceof Error ? e.message : "Действие не удалось"); }
  }

  async function diplomacy(targetStateId: string, action: DiplomacyAction) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        setSnapshot(demoDiplomacyAction(snapshot, targetStateId, action));
        notify("Дипломатическая команда отправлена");
        return;
      }
      await api<{ diplomacy: DiplomacyRelationView[] }>("/api/game/diplomacy", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, targetStateId, action }),
      });
      await refreshLive();
      notify("Отношения островов обновлены");
    } catch (e) { notify(e instanceof Error ? e.message : "Дипломатия не удалась"); }
  }

  async function claimMission(missionId: string) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        const mission = snapshot.dailyMissions.find((item) => item.id === missionId);
        if (!mission || mission.claimed || mission.progress < mission.target) return notify("Задание ещё не выполнено");
        setSnapshot(demoClaimMission(snapshot, missionId));
        notify(`Награда: +${mission.rewardXp} XP, +${mission.rewardCredits} ₡`);
        return;
      }
      const fresh = await api<GameSnapshot>("/api/game/missions/claim", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, missionId }) });
      acceptSnapshot(fresh);
      notify("Награда получена");
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось получить награду"); }
  }

  async function politics(action: string, payload: Record<string, string> = {}) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        setSnapshot(demoPoliticsAction(snapshot, action, payload));
        notify(action === "vote" ? "Голос учтён" : "Политическое действие выполнено");
        return;
      }
      const fresh = await api<GameSnapshot>("/api/game/politics", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, action, ...payload }) });
      acceptSnapshot(fresh);
      notify(action === "vote" ? "Голос учтён" : "Государство обновлено");
    } catch (e) { notify(e instanceof Error ? e.message : "Политическое действие не удалось"); }
  }

  async function customizeState(patch: Partial<Pick<StateView, "motto" | "emblem" | "theme" | "color">>) {
    if (!snapshot) return;
    try {
      if (snapshot.mode === "demo") {
        setSnapshot(demoCustomizeState(snapshot, patch));
        notify("Оформление острова обновлено");
        return;
      }
      const fresh = await api<GameSnapshot>("/api/game/customize", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, ...patch }) });
      acceptSnapshot(fresh);
      notify("Оформление острова обновлено");
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить оформление"); }
  }

  if (loading) return <Splash text="Ищем ваш остров…" />;
  if (error || !snapshot) return <Splash text={error || "Ошибка"} action="Повторить" onAction={bootstrap} />;

  return (
    <main className="app-shell island-app-shell">
      <MobileHeader snapshot={snapshot} />

      <section className="viewport island-viewport">
        {view === "map" && (
          <IslandMap
            snapshot={snapshot}
            selected={selectedIsland}
            onSelect={setSelectedIsland}
            onAttack={attackIsland}
            onExplore={exploreIslands}
            onOpenBattle={() => setView("battle")}
          />
        )}
        {view === "island" && <IslandHome snapshot={snapshot} onUpgrade={upgrade} onRepair={repairOwnIsland} />}
        {view === "battle" && <BattleScreen battle={snapshot.activeBattle || null} playerName={snapshot.player.displayName} onJoin={joinBattle} onAction={actBattle} />}
        {view === "rating" && <IslandRanking snapshot={snapshot} />}
        {view === "alliances" && <IslandAlliances snapshot={snapshot} onDiplomacy={diplomacy} />}
        {view === "profile" && <StateViewPanel snapshot={snapshot} onClaim={claimMission} onPolitics={politics} onCustomize={customizeState} />}
      </section>

      <nav className="bottom-nav island-bottom-nav">
        {NAV.map((item) => (
          <button type="button" key={item.key} aria-current={view === item.key ? "page" : undefined} aria-label={item.label} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>
            <NavIcon type={item.key} /><small>{item.label}</small>
          </button>
        ))}
      </nav>
      {toast && <div className="toast">{toast}</div>}
      {snapshot.mode === "demo" && <div className="demo-badge">DEMO</div>}
    </main>
  );
}

function Splash({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return <main className="splash"><div className="logo-mark">GW</div><h1>GROUP WARS</h1><p>{text}</p>{action && <button className="primary" onClick={onAction}>{action}</button>}</main>;
}

const MobileHeader = memo(function MobileHeader({ snapshot }: { snapshot: GameSnapshot }) {
  const state = snapshot.state;
  const role = snapshot.player.role === "president" ? "Президент" : snapshot.player.role === "minister" ? "Министр" : snapshot.player.role === "general" ? "Генерал" : "Гражданин";
  const compact = (value: number) => new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return (
    <header className="island-mobile-header game-mobile-header">
      <div className="game-header-identity">
        <button className="hamburger game-hamburger" type="button" aria-label="Меню"><i /><i /><i /></button>
        <span className="header-avatar game-header-avatar" style={{ background: state.color }}>{state.avatarUrl ? <Image src={state.avatarUrl} alt="" width={42} height={42} unoptimized /> : state.emblem}</span>
        <div className="header-state-name game-header-name"><b>{state.name}</b><small>{role}</small></div>
      </div>
      <div className="game-header-stats">
        <div className="game-stat-chip"><NavIcon type="rating" /><div><b>{state.rating}</b><small>ELO</small></div></div>
        <div className="game-stat-chip"><NavIcon type="profile" /><div><b>{compact(state.memberCount)}</b><small>людей</small></div></div>
        <div className="game-stat-chip coin"><span className="coin-mark">●</span><div><b>{compact(state.treasury.credits)}</b><small>казна</small></div></div>
      </div>
    </header>
  );
});

function NavIcon({ type }: { type: View }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (type === "map") return <svg {...common}><path d="M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20Z"/><path d="M9 4v13.5M15 6.5V20"/></svg>;
  if (type === "island") return <svg {...common}><path d="M5 17c3.2-2.1 4.6-5.4 5.6-9.5 3.5 1.4 5.4 4.1 6.4 7.9"/><path d="M3 18.5c3.5-1.3 6.2-.7 8.9 1 3-1.6 6-1.8 9.1-.4"/><path d="M11 8c1-2 2.5-3.1 4.5-3.4"/></svg>;
  if (type === "battle") return <svg {...common}><path d="m6 4 5 5-6.5 6.5M18 4l-5 5 6.5 6.5"/><path d="m3.5 18.5 3-3 2 2-3 3ZM20.5 18.5l-3-3-2 2 3 3Z"/></svg>;
  if (type === "rating") return <svg {...common}><path d="M7 4h10v3.5c0 3.4-2.2 6-5 6s-5-2.6-5-6Z"/><path d="M7 6H4v2c0 2 1.3 3 3.4 3M17 6h3v2c0 2-1.3 3-3.4 3M12 13.5V18M8.5 20h7"/></svg>;
  if (type === "alliances") return <svg {...common}><path d="M7.5 13.5 4 10l3-3 3.5 3.5M16.5 13.5 20 10l-3-3-3.5 3.5"/><path d="m9.5 9.5 2.5-2 2.5 2M8.5 14.5 12 17l3.5-2.5"/></svg>;
  return <svg {...common}><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.8-4 3-6 6.5-6s5.7 2 6.5 6"/></svg>;
}

function SceneLoading({ label }: { label: string }) {
  return <div className="scene-loading"><i /><span>{label}</span></div>;
}
