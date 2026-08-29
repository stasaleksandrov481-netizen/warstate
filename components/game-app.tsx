"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import type {
  BattleClass,
  BattleView,
  BuildingType,
  DiplomacyAction,
  DiplomacyRelationView,
  GameSnapshot,
  IslandView,
  StateView,
  WarType,
} from "@/lib/types";
import { IslandMap } from "@/components/game/island-map";
const IslandHome = dynamic(() => import("@/components/game/island-home").then((m) => m.IslandHome), { ssr: false, loading: () => <SceneLoading label="Открываем замок…" /> });
const IslandRanking = dynamic(() => import("@/components/game/island-ranking").then((m) => m.IslandRanking), { ssr: false, loading: () => <SceneLoading label="Считаем рейтинг…" /> });
const IslandAlliances = dynamic(() => import("@/components/game/island-alliances").then((m) => m.IslandAlliances), { ssr: false, loading: () => <SceneLoading label="Открываем дипломатию…" /> });

const BattleScreen = dynamic(() => import("@/components/game/battle-screen").then((m) => m.BattleScreen), { ssr: false, loading: () => <SceneLoading label="Открываем армию…" /> });
const AdminPanel = dynamic(() => import("@/components/game/admin-panel").then((m) => m.AdminPanel), { ssr: false, loading: () => <SceneLoading label="Открываем админ-панель…" /> });
const StateViewPanel = dynamic(() => import("@/components/game/state-view").then((m) => m.StateViewPanel), { ssr: false, loading: () => <SceneLoading label="Открываем профиль…" /> });
const StrategyPanel = dynamic(() => import("@/components/game/strategy-panel").then((m) => m.StrategyPanel), { ssr: false, loading: () => <SceneLoading label="Открываем штаб…" /> });

type View = "home" | "map" | "island" | "battle" | "rating" | "alliances" | "strategy" | "profile";

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string } };
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  openTelegramLink?: (url: string) => void;
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (cb: () => void) => void; offClick?: (cb: () => void) => void };
  HapticFeedback?: { impactOccurred?: (style: string) => void; notificationOccurred?: (type: string) => void };
};

function tg(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return (window as any).Telegram?.WebApp || null;
}

class ApiRequestError extends Error {
  inviteLink: string | null;
  constructor(message: string, inviteLink: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.inviteLink = inviteLink;
  }
}

function mergeIslandLists(current: IslandView[] = [], incoming: IslandView[] = [], max = 520) {
  const incomingIds = new Set(incoming.map((item) => item.id));
  const merged = [...incoming, ...current.filter((item) => !incomingIds.has(item.id))];
  const mine = merged.find((item) => item.isMine);
  const rest = merged.filter((item) => !item.isMine);
  return mine ? [mine, ...rest].slice(0, max) : rest.slice(0, max);
}

async function api<T>(path: string, initData: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-telegram-init-data": initData,
        ...(init?.headers || {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* non-JSON gateway errors */ }
    if (!response.ok) {
      const payload = typeof json === "object" && json ? json as { error?: unknown; inviteLink?: unknown } : null;
      const message = payload?.error ? String(payload.error) : "";
      const inviteLink = payload?.inviteLink ? String(payload.inviteLink) : null;
      throw new ApiRequestError(message || `Сервер вернул ошибку ${response.status}`, inviteLink);
    }
    return json as T;
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) throw new Error("Сервер не ответил вовремя. Проверь соединение и повтори попытку.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

const COMPACT_FORMATTER = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });

const NAV: Array<{ key: View; label: string }> = [
  { key: "home", label: "Меню" },
  { key: "map", label: "Карта" },
  { key: "island", label: "Замок" },
  { key: "battle", label: "Армия" },
  { key: "profile", label: "Профиль" },
];

export default function GameApp() {
  const [view, setView] = useState<View>("home");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [sectionHelp, setSectionHelp] = useState<{ title: string; text: string } | null>(null);
  const [viewPhase, setViewPhase] = useState<"idle" | "leaving" | "entering">("idle");
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [selectedIsland, setSelectedIsland] = useState<IslandView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "info" | "success" | "error" } | null>(null);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [lastSyncAt, setLastSyncAt] = useState(() => Date.now());
  const [syncing, setSyncing] = useState(false);
  const [telegramReady, setTelegramReady] = useState(false);
  const refreshLiveTimer = useRef<number | null>(null);
  const refreshBattleTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const exploreTimer = useRef<number | null>(null);
  const exploreAbortRef = useRef<AbortController | null>(null);
  const refreshLiveInFlightRef = useRef(false);
  const refreshBattleInFlightRef = useRef(false);
  const lastExploreRef = useRef<{ x: number; y: number; radius: number; at: number } | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const navigationEnterTimerRef = useRef<number | null>(null);
  const telegram = typeof window !== "undefined" ? tg() : null;
  const initData = telegram?.initData || "";
  // Telegram can expose the start parameter through initDataUnsafe or through
  // tgWebAppStartParam depending on client/version. Accept both forms so the
  // admin deep-link cannot accidentally boot the normal game.
  // Fixed: compute isAdminEntry reactively so it re-evaluates once the
  // Telegram WebApp SDK is ready and initDataUnsafe.start_param is populated.
  const detectAdminEntry = useCallback(() => {
    if (typeof window === "undefined") return false;
    const app = tg();
    const urlSP = new URLSearchParams(window.location.search);
    const hashSP = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const initSP = app?.initDataUnsafe?.start_param;
    const initDataSP = app?.initData ? new URLSearchParams(app.initData).get("start_param") : null;
    return initSP === "admin"
      || initDataSP === "admin"
      || urlSP.get("admin") === "1"
      || urlSP.get("tgWebAppStartParam") === "admin"
      || urlSP.get("startapp") === "admin"
      || hashSP.get("tgWebAppStartParam") === "admin"
      || hashSP.get("startapp") === "admin";
  }, []);

  const [isAdminEntry, setIsAdminEntry] = useState(() => detectAdminEntry());

  useEffect(() => {
    if (!telegramReady) return;
    let attempts = 0;
    const check = () => {
      attempts += 1;
      if (detectAdminEntry()) { setIsAdminEntry(true); return true; }
      return attempts >= 30;
    };
    if (check()) return;
    const timer = window.setInterval(() => {
      if (check()) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [telegramReady, detectAdminEntry]);

  useEffect(() => {
    try {
      if (window.localStorage.getItem("warstate:onboarding:v5") !== "done") setOnboardingOpen(true);
    } catch { setOnboardingOpen(true); }
  }, []);

  const finishOnboarding = useCallback(() => {
    try { window.localStorage.setItem("warstate:onboarding:v5", "done"); } catch { /* storage optional */ }
    setOnboardingOpen(false);
  }, []);

  const acceptSnapshot = useCallback((fresh: GameSnapshot) => {
    setSnapshot((current) => ({
      ...fresh,
      islands: mergeIslandLists(current?.islands || [], fresh.islands || []),
    }));
  }, []);

  const navigate = useCallback((next: View) => {
    if (next === view) return;
    tg()?.HapticFeedback?.impactOccurred?.("light");
    if (navigationTimerRef.current) window.clearTimeout(navigationTimerRef.current);
    if (navigationEnterTimerRef.current) window.clearTimeout(navigationEnterTimerRef.current);
    setViewPhase("leaving");
    navigationTimerRef.current = window.setTimeout(() => {
      if (next !== "map") setSelectedIsland(null);
      setView(next);
      setViewPhase("entering");
      navigationEnterTimerRef.current = window.setTimeout(() => setViewPhase("idle"), 280);
    }, 145);
  }, [view]);

  const notify = useCallback((message: string, tone: "info" | "success" | "error" = "info") => {
    setToast({ message, tone });
    if (tone === "success") tg()?.HapticFeedback?.notificationOccurred?.("success");
    if (tone === "error") tg()?.HapticFeedback?.notificationOccurred?.("error");
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
      // Telegram does not support a truly transparent native chrome on every client.
      // Matching the chrome to the app background makes the Mini App frame visually disappear.
      app?.setHeaderColor?.("#1d1c17");
      app?.setBackgroundColor?.("#1d1c17");
      app?.setBottomBarColor?.("#1d1c17");
      app?.disableVerticalSwipes?.();
      if (!app?.initData) {
        throw new Error("Откройте live-версию игры внутри Telegram Mini App.");
      }
      const data = await api<GameSnapshot>("/api/game/bootstrap", app.initData, { method: "POST" });
      setSnapshot(data);
      setLastSyncAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось открыть игру");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (tg()) {
        setTelegramReady(true);
        window.clearInterval(timer);
      } else if (attempts >= 30) {
        setTelegramReady(true);
        window.clearInterval(timer);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!telegramReady || isAdminEntry) return;
    void bootstrap();
  }, [bootstrap, isAdminEntry, telegramReady]);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (refreshLiveTimer.current) window.clearTimeout(refreshLiveTimer.current);
    if (refreshBattleTimer.current) window.clearTimeout(refreshBattleTimer.current);
    if (exploreTimer.current) window.clearTimeout(exploreTimer.current);
    if (navigationTimerRef.current) window.clearTimeout(navigationTimerRef.current);
    if (navigationEnterTimerRef.current) window.clearTimeout(navigationEnterTimerRef.current);
    exploreAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const app = tg();
    const back = app?.BackButton;
    if (!back) return;
    const handleBack = () => {
      if (selectedIsland) { setSelectedIsland(null); return; }
      if (view === "strategy") { navigate("island"); return; }
      if (view !== "map") navigate("map");
    };
    if (view === "map" && !selectedIsland) back.hide?.(); else back.show?.();
    back.onClick?.(handleBack);
    return () => back.offClick?.(handleBack);
  }, [view, selectedIsland?.id, navigate]);


  useEffect(() => {
    if (!selectedIsland || !snapshot) return;
    const fresh = snapshot.islands.find((item) => item.id === selectedIsland.id);
    if (fresh && fresh !== selectedIsland) setSelectedIsland(fresh);
  }, [snapshot?.islands, selectedIsland?.id]);

  const refreshLive = useCallback(async () => {
    if (!snapshot || !initData || refreshLiveInFlightRef.current) return;
    refreshLiveInFlightRef.current = true;
    try {
      const fresh = await api<GameSnapshot>(`/api/game/state?stateId=${snapshot.state.id}`, initData);
      acceptSnapshot(fresh);
      setLastSyncAt(Date.now());
    } catch {
      // Realtime/visibility refreshes are best-effort. A transient Vercel or
      // mobile-network failure must not become an unhandled promise rejection.
    } finally {
      refreshLiveInFlightRef.current = false;
    }
  }, [snapshot?.state.id, initData, acceptSnapshot]);

  const syncNow = useCallback(async () => {
    if (!snapshot || !initData || syncing) return;
    setSyncing(true);
    try {
      const fresh = await api<GameSnapshot>(`/api/game/state?stateId=${snapshot.state.id}`, initData);
      acceptSnapshot(fresh);
      setLastSyncAt(Date.now());
      notify("Данные синхронизированы", "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Не удалось синхронизировать данные", "error");
    } finally {
      setSyncing(false);
    }
  }, [snapshot?.state.id, initData, syncing, acceptSnapshot, notify]);

  const scheduleRefreshLive = useCallback(() => {
    if (refreshLiveTimer.current) window.clearTimeout(refreshLiveTimer.current);
    refreshLiveTimer.current = window.setTimeout(() => { void refreshLive(); }, 220);
  }, [refreshLive]);

  useEffect(() => {
    const online = () => { setIsOnline(true); scheduleRefreshLive(); };
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [scheduleRefreshLive]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") scheduleRefreshLive();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [scheduleRefreshLive]);

  const refreshBattle = useCallback(async () => {
    const battleId = snapshot?.activeBattle?.id;
    if (!battleId || !initData || refreshBattleInFlightRef.current) return;
    refreshBattleInFlightRef.current = true;
    try {
      const battle = await api<BattleView>(`/api/game/battle?battleId=${battleId}`, initData);
      if (battle.status === "resolved") {
        // Clear the battle from snapshot so LIVE badge disappears immediately.
        // A full snapshot refresh will follow via scheduleRefreshLive.
        setSnapshot((current) => current ? { ...current, activeBattle: null } : current);
        window.setTimeout(() => scheduleRefreshLive(), 300);
      } else {
        setSnapshot((current) => current ? { ...current, activeBattle: battle } : current);
      }
      setLastSyncAt(Date.now());
    } catch { /* realtime can race with resolution */ }
    finally { refreshBattleInFlightRef.current = false; }
  }, [snapshot?.activeBattle?.id, initData, scheduleRefreshLive]);

  const scheduleRefreshBattle = useCallback(() => {
    if (refreshBattleTimer.current) window.clearTimeout(refreshBattleTimer.current);
    refreshBattleTimer.current = window.setTimeout(() => { void refreshBattle(); }, 120);
  }, [refreshBattle]);

  useEffect(() => {
    if (!snapshot) return;
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    const channel = supabase
      .channel(`island-world-${snapshot.state.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "states", filter: `id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .on("postgres_changes", { event: "*", schema: "public", table: "diplomacy_relations", filter: `state_a_id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .on("postgres_changes", { event: "*", schema: "public", table: "diplomacy_relations", filter: `state_b_id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .on("postgres_changes", { event: "*", schema: "public", table: "state_elections", filter: `state_id=eq.${snapshot.state.id}` }, scheduleRefreshLive)
      .subscribe();
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") scheduleRefreshLive(); };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const slowTimer = window.setInterval(() => { if (document.visibilityState === "visible") scheduleRefreshLive(); }, 75_000);
    return () => {
      window.clearInterval(slowTimer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      void supabase.removeChannel(channel);
    };
  }, [snapshot?.state.id, scheduleRefreshLive]);

  useEffect(() => {
    const battleId = snapshot?.activeBattle?.id;
    if (!battleId) return;
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    const channel = supabase
      .channel(`battle-${battleId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "battles", filter: `id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_players", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "battle_events", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_orders", filter: `battle_id=eq.${battleId}` }, scheduleRefreshBattle)
      .subscribe();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshBattle(); }, 5000);
    return () => { window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [snapshot?.activeBattle?.id, scheduleRefreshBattle, refreshBattle]);

  const exploreIslands = useCallback((x: number, y: number, radius: number) => {
    if (!snapshot || !initData) return;
    const previous = lastExploreRef.current;
    const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : Number.POSITIVE_INFINITY;
    if (previous && Date.now() - previous.at < 4500 && distance < Math.min(radius, previous.radius) * 0.18 && radius <= previous.radius * 1.12) return;
    lastExploreRef.current = { x, y, radius, at: Date.now() };
    if (exploreTimer.current) window.clearTimeout(exploreTimer.current);
    exploreTimer.current = window.setTimeout(async () => {
      exploreAbortRef.current?.abort();
      const controller = new AbortController();
      exploreAbortRef.current = controller;
      try {
        const data = await api<{ islands: IslandView[] }>(`/api/game/islands?stateId=${snapshot.state.id}&x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}&radius=${Math.round(radius)}`, initData, { signal: controller.signal });
        setSnapshot((current) => current ? { ...current, islands: mergeIslandLists(current.islands, data.islands) } : current);
        setSelectedIsland((current) => current ? data.islands.find((item) => item.id === current.id) || current : null);
      } catch { /* blank water is better than noisy errors while panning */ }
      finally { if (exploreAbortRef.current === controller) exploreAbortRef.current = null; }
    }, 220);
  }, [snapshot?.state.id, initData]);

  async function upgrade(type: BuildingType) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/upgrade", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, buildingType: type }),
      });
      acceptSnapshot(fresh);
      notify("Инфраструктура улучшена", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Ошибка улучшения", "error"); }
  }

  async function repairOwnIsland(amount = 25) {
    if (!snapshot) return;
    try {
      const result = await api<{ snapshot: GameSnapshot; repair: { integrity: number; repaired: number; creditsCost: number; steelCost: number } }>("/api/game/island/repair", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, amount }),
      });
      acceptSnapshot(result.snapshot);
      notify(`+${result.repair.repaired}% прочности · ${result.repair.integrity}%`, "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Ремонт не удался", "error"); }
  }

  async function attackIsland(island: IslandView, battleType: WarType = "raid") {
    if (!snapshot) return;
    try {
      await api<{ voteId: string; endsAt: string; voteStarted: true }>("/api/game/island/attack", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, targetStateId: island.id, battleType }),
      });
      setSelectedIsland(null);
      await refreshLive();
      notify("Голосование о войне отправлено в чат государства", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Голосование не запущено", "error"); }
  }

  const switchInFlightRef = useRef(false);
  async function switchState(island: IslandView) {
    if (!snapshot || island.isMine || island.isFreeport) return;
    // Guard against rapid repeated taps on "Перейти" firing many parallel requests — each one used to
    // trigger its own invite-link DM from the bot, which is what was spamming the player's chat with it.
    if (switchInFlightRef.current) return;
    switchInFlightRef.current = true;
    try {
      const fresh = await api<GameSnapshot>("/api/game/state/switch", initData, {
        method: "POST",
        body: JSON.stringify({ targetStateId: island.id }),
      });
      setSelectedIsland(null);
      setSnapshot(fresh);
      setLastSyncAt(Date.now());
      navigate("island");
      notify(`Теперь вы гражданин государства «${fresh.state.name}»`, "success");
    } catch (e) {
      if (e instanceof ApiRequestError && e.inviteLink) {
        tg()?.openTelegramLink?.(e.inviteLink);
        if (!tg()?.openTelegramLink) window.open(e.inviteLink, "_blank", "noopener,noreferrer");
        notify("Сначала вступите в Telegram-чат, затем нажмите «Перейти» ещё раз", "info");
        return;
      }
      notify(e instanceof Error ? e.message : "Не удалось сменить государство", "error");
    } finally {
      switchInFlightRef.current = false;
    }
  }

  async function joinBattle(klass: BattleClass) {
    if (!snapshot?.activeBattle) return;
    try {
      const battle = await api<BattleView>("/api/game/battle/join", initData, { method: "POST", body: JSON.stringify({ battleId: snapshot.activeBattle.id, class: klass }) });
      setSnapshot((current) => current ? { ...current, activeBattle: battle } : current);
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось войти в бой", "error"); }
  }

  async function actBattle(action: string, payload: Record<string, unknown> = {}) {
    if (!snapshot?.activeBattle) return;
    try {
      const battle = await api<BattleView>("/api/game/battle/action", initData, { method: "POST", body: JSON.stringify({ battleId: snapshot.activeBattle.id, action, ...payload }) });
      setSnapshot((current) => current ? { ...current, activeBattle: battle } : current);
    } catch (e) { notify(e instanceof Error ? e.message : "Действие не удалось", "error"); }
  }

  async function diplomacy(targetStateId: string, action: DiplomacyAction) {
    if (!snapshot) return;
    try {
      await api<{ diplomacy: DiplomacyRelationView[] }>("/api/game/diplomacy", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, targetStateId, action }),
      });
      await refreshLive();
      notify(["propose_alliance", "accept_alliance"].includes(action) ? "Голосование о союзе отправлено в чат" : "Дипломатические отношения обновлены", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Дипломатия не удалась", "error"); }
  }

  async function completeActivity(activityKey: string, optionKey: string) {
    if (!snapshot) return;
    try {
      const result = await api<{ snapshot: GameSnapshot; result: { success?: boolean; contribution?: number } }>("/api/game/activity", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, activityKey, optionKey }),
      });
      acceptSnapshot(result.snapshot);
      notify(result.result?.success === false ? "Операция прошла с осложнениями" : `Решение выполнено · вклад +${result.result?.contribution || 0}`, result.result?.success === false ? "info" : "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Активность не выполнена", "error"); }
  }

  async function supportAlly(battleId: string, side: "attacker" | "defender") {
    if (!snapshot) return;
    try {
      const result = await api<{ snapshot: GameSnapshot; result: { power?: number } }>("/api/game/battle/support", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, battleId, side }),
      });
      acceptSnapshot(result.snapshot);
      notify(`Союзнику отправлено +${result.result?.power || 0} силы`, "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Поддержка не отправлена", "error"); }
  }

  async function surrenderCurrentBattle() {
    if (!snapshot?.activeBattle) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/battle/surrender", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, battleId: snapshot.activeBattle.id }),
      });
      acceptSnapshot(fresh);
      setSnapshot((current) => current ? { ...current, activeBattle: null } : current);
      notify("Бой завершён", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось завершить бой", "error"); }
  }

  async function claimMission(missionId: string) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/missions/claim", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, missionId }) });
      acceptSnapshot(fresh);
      notify("Награда получена", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось получить награду", "error"); }
  }

  async function politics(action: string, payload: Record<string, string> = {}) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/politics", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, action, ...payload }) });
      acceptSnapshot(fresh);
      notify(action === "vote" ? "Голос учтён" : "Государство обновлено", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Политическое действие не удалось", "error"); }
  }


  async function government(action: string, payload: Record<string, string> = {}) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/government", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, action, ...payload }) });
      acceptSnapshot(fresh);
      if (action === "delete_state") {
        setSelectedIsland(null);
        navigate("map");
        notify("Государство удалено. Игроки переведены в нейтральную зону", "success");
      } else {
        notify("Правительство обновлено", "success");
      }
    } catch (e) { notify(e instanceof Error ? e.message : "Действие правительства не удалось", "error"); }
  }

  async function customizeState(patch: Partial<Pick<StateView, "motto" | "emblem" | "theme" | "color">>) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/customize", initData, { method: "POST", body: JSON.stringify({ stateId: snapshot.state.id, ...patch }) });
      acceptSnapshot(fresh);
      notify("Оформление государства обновлено", "success");
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить оформление", "error"); }
  }

  async function recruitment(action: string, payload: Record<string, unknown> = {}) {
    if (!snapshot) return;
    try {
      const fresh = await api<GameSnapshot>("/api/game/recruitment", initData, {
        method: "POST",
        body: JSON.stringify({ stateId: snapshot.state.id, action, ...payload }),
      });
      acceptSnapshot(fresh);
      notify("Набор обновлён", "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Не удалось выполнить действие набора", "error");
    }
  }

  if (!telegramReady) return <Splash text="Подключаем Telegram Mini App…" />;
  if (isAdminEntry) {
    if (!initData) return <Splash text="Не удалось получить Telegram-сессию. Закройте и снова откройте Mini App из Telegram." />;
    return <AdminPanel initData={initData} />;
  }

  if (loading) return <Splash text="Загружаем карту государств…" />;
  if (error || !snapshot) return <Splash text={error || "Ошибка"} action="Повторить" onAction={bootstrap} />;

  const availableNav = NAV;
  const hasWorldPulse = hasActiveWorldPulse(snapshot);

  return (
    <main className={`app-shell island-app-shell ${hasWorldPulse ? "has-world-pulse" : ""}`}>
      <MobileHeader snapshot={snapshot} online={isOnline} lastSyncAt={lastSyncAt} syncing={syncing} onSync={syncNow} />
      <WorldPulseBar snapshot={snapshot} onBattle={() => navigate("battle")} onIsland={() => navigate("island")} onProfile={() => navigate("profile")} />

      <section className={`viewport island-viewport ws-view-${viewPhase}`} data-view={view}>
        <div className="ws-view-stage" key={view}>
        {view === "home" && <CommandCenter snapshot={snapshot} onNavigate={navigate} onExplain={setSectionHelp} />}
        {view === "map" && (
          <IslandMap
            snapshot={snapshot}
            selected={selectedIsland}
            onSelect={setSelectedIsland}
            onAttack={attackIsland}
            onSwitchState={switchState}
            onExplore={exploreIslands}
            onOpenBattle={() => navigate("battle")}
            onOpenIsland={() => navigate("island")}
          />
        )}
        {view === "island" && <IslandHome snapshot={snapshot} onUpgrade={upgrade} onRepair={repairOwnIsland} onRecruitment={recruitment} onOpenStrategy={() => navigate("strategy")} />}
        {view === "battle" && <BattleScreen battle={snapshot.activeBattle || null} playerName={snapshot.player.displayName} freeport={snapshot.state.isFreeport} onJoin={joinBattle} onAction={actBattle} onOpenMap={() => navigate("map")} />}
        {view === "rating" && <IslandRanking snapshot={snapshot} />}
        {view === "alliances" && <IslandAlliances snapshot={snapshot} onDiplomacy={diplomacy} />}
        {view === "strategy" && <StrategyPanel snapshot={snapshot} onActivity={completeActivity} onSupport={supportAlly} onSurrender={surrenderCurrentBattle} />}
        {view === "profile" && <StateViewPanel snapshot={snapshot} onClaim={claimMission} onPolitics={politics} onGovernment={government} onCustomize={customizeState} />}
        </div>
      </section>

      <nav className="bottom-nav island-bottom-nav">
        {availableNav.map((item) => (
          <button type="button" key={item.key} aria-current={view === item.key ? "page" : undefined} aria-label={item.label} className={(view === item.key || (view === "strategy" && item.key === "island")) ? "active" : ""} onClick={() => navigate(item.key)}>
            <span className="nav-icon-wrap"><NavIcon type={item.key} />
              {item.key === "battle" && snapshot.activeBattle && snapshot.activeBattle.status !== "resolved" && new Date(snapshot.activeBattle.endsAt).getTime() > Date.now() && new Date(snapshot.activeBattle.startsAt || 0).getTime() < Date.now() + 24 * 60 * 60 * 1000 ? <i className="nav-live-dot" /> : null}
              {item.key === "alliances" && snapshot.diplomacy.some((rel) => rel.status.endsWith("_pending") && rel.requestedByStateId !== snapshot.state.id) ? <i className="nav-pending-dot" /> : null}
              {item.key === "island" && snapshot.buildings.some((building) => building.upgradeFinishesAt && new Date(building.upgradeFinishesAt).getTime() > Date.now()) ? <i className="nav-build-dot" /> : null}
              {item.key === "profile" && snapshot.dailyMissions.some((mission) => !mission.claimed && mission.progress >= mission.target) ? <i className="nav-reward-dot" /> : null}
            </span><small>{item.label}</small>
          </button>
        ))}
      </nav>
      {view !== "home" && <button type="button" className="section-help-trigger" onClick={() => setSectionHelp(sectionHelpFor(view))}>?<span>Что это?</span></button>}
      {sectionHelp && <SectionHelpModal info={sectionHelp} onClose={() => setSectionHelp(null)} />}
      {onboardingOpen && <Onboarding onDone={finishOnboarding} />}
      {toast && <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite"><span>{toast.message}</span></div>}
    </main>
  );
}


function sectionHelpFor(view: View) {
  const map: Record<View, { title: string; text: string }> = {
    home: { title: "Главное меню", text: "Здесь собраны основные разделы государства. Начните с замка, затем откройте карту и проверьте армию." },
    map: { title: "Карта", text: "Общий материк WARSTATE. Масштаб меняет детализацию: от гербов до полной карточки государства." },
    island: { title: "Замок", text: "Центр государства: казна, инфраструктура, развитие и восстановление." },
    battle: { title: "Армия", text: "Текущий бой, участие граждан, приказы и состояние сил государства." },
    rating: { title: "Рейтинг", text: "Позиции государств по ELO и результаты текущего сезона." },
    alliances: { title: "Союзы", text: "Партнёры, запросы на союз, перемирия и дипломатические действия." },
    strategy: { title: "Операции", text: "Ежедневные действия, поддержка союзников и решения по текущим конфликтам." },
    profile: { title: "Профиль и выборы", text: "Роль, заслуги, ежедневные задачи, руководство государства и президентские выборы." },
  };
  return map[view];
}

function CommandCenter({ snapshot, onNavigate, onExplain }: { snapshot: GameSnapshot; onNavigate: (view: View) => void; onExplain: (info: { title: string; text: string }) => void }) {
  const cards: Array<{ view: View; icon: string; label: string; hint: string }> = [
    { view: "island", icon: "♜", label: "Замок", hint: "Казна и развитие" },
    { view: "battle", icon: "⚔", label: "Армия", hint: "Бои и приказы" },
    { view: "alliances", icon: "◆", label: "Союзы", hint: "Дипломатия" },
    { view: "profile", icon: "§", label: "Выборы", hint: "Роли и власть" },
    { view: "map", icon: "▣", label: "Карта", hint: "Материк государств" },
    { view: "rating", icon: "♛", label: "Рейтинг", hint: "ELO и сезон" },
  ];
  return <div className="command-center">
    <section className="command-hero">
      <div><small>WARSTATE</small><h2>Управление государством</h2><p>Выберите раздел. Основные действия доступны без поиска по меню.</p></div>
      <span className="command-crest" style={{ background: snapshot.state.color }}>{snapshot.state.emblem || "W"}</span>
    </section>
    <div className="command-summary">
      <span><small>Казна</small><b>{COMPACT_FORMATTER.format(snapshot.state.treasury.credits)}</b></span>
      <span><small>Армия</small><b>{COMPACT_FORMATTER.format(snapshot.state.armyPower)}</b></span>
      <span><small>Население</small><b>{COMPACT_FORMATTER.format(snapshot.state.memberCount)}</b></span>
    </div>
    <section className="command-grid" aria-label="Главное меню">
      {cards.map((card) => <article key={card.view} className="command-tile">
        <button type="button" className="command-tile-main" onClick={() => onNavigate(card.view)}><i>{card.icon}</i><span><b>{card.label}</b><small>{card.hint}</small></span></button>
        <button type="button" className="command-tile-help" aria-label={`Что такое ${card.label}`} onClick={() => onExplain(sectionHelpFor(card.view))}>?</button>
      </article>)}
    </section>
    <div className="command-note"><b>Новому игроку:</b> откройте «Замок», затем «Карта». Этого достаточно, чтобы понять текущее состояние и соседей.</div>
  </div>;
}

function SectionHelpModal({ info, onClose }: { info: { title: string; text: string }; onClose: () => void }) {
  return <div className="section-help-backdrop" role="presentation" onClick={onClose}><section className="section-help-modal" role="dialog" aria-modal="true" aria-label={info.title} onClick={(e) => e.stopPropagation()}><button type="button" onClick={onClose}>×</button><small>СПРАВКА</small><h3>{info.title}</h3><p>{info.text}</p><b>Закрыть справку можно касанием вне карточки.</b></section></div>;
}

const ONBOARDING_SLIDES = [
  { icon: "♜", title: "Начните с замка", text: "Проверьте казну, армию и развитие государства." },
  { icon: "▣", title: "Откройте карту", text: "Найдите соседей, союзников и противников на материке." },
  { icon: "◆", title: "Следите за решениями", text: "Союзы, войны и выборы подтверждаются понятными действиями." },
  { icon: "!", title: "Реагируйте на ЧП", text: "На решение есть 10 минут. Бот всегда показывает доступные варианты." },
];

function Onboarding({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const slide = ONBOARDING_SLIDES[index];
  return <div className="onboarding-backdrop"><section className="onboarding-card" role="dialog" aria-modal="true" aria-label="Знакомство с WARSTATE">
    <button type="button" className="onboarding-skip" onClick={onDone}>Пропустить</button>
    <div className="onboarding-icon">{slide.icon}</div>
    <small>ШАГ {index + 1} ИЗ {ONBOARDING_SLIDES.length}</small>
    <h2>{slide.title}</h2><p>{slide.text}</p>
    <div className="onboarding-dots">{ONBOARDING_SLIDES.map((_, dot) => <i key={dot} className={dot === index ? "active" : ""} />)}</div>
    <button type="button" className="onboarding-next" onClick={() => index === ONBOARDING_SLIDES.length - 1 ? onDone() : setIndex(index + 1)}>{index === ONBOARDING_SLIDES.length - 1 ? "Открыть WARSTATE" : "Далее"}</button>
  </section></div>;
}

function Splash({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return <main className="splash ws-splash"><div className="ws-splash-orbit"><div className="logo-mark">WS</div></div><h1>WARSTATE</h1><p>{text}</p><div className="ws-loading-bars" aria-hidden="true"><i/><i/><i/></div>{action && <button className="primary" onClick={onAction}>{action}</button>}</main>;
}

function hasActiveWorldPulse(snapshot: GameSnapshot) {
  const now = Date.now();
  const activeBattle = Boolean(
    snapshot.activeBattle &&
    snapshot.activeBattle.status !== "resolved" &&
    new Date(snapshot.activeBattle.endsAt).getTime() > now
  );
  const activeConstruction = snapshot.buildings.some((building) => building.upgradeFinishesAt && new Date(building.upgradeFinishesAt).getTime() > now);
  const activeElection = Boolean(snapshot.election?.status === "open" && new Date(snapshot.election.endsAt).getTime() > now);
  const readyReward = snapshot.dailyMissions.some((mission) => !mission.claimed && mission.progress >= mission.target);
  return activeBattle || activeConstruction || activeElection || readyReward;
}

function WorldPulseBar({ snapshot, onBattle, onIsland, onProfile }: { snapshot: GameSnapshot; onBattle: () => void; onIsland: () => void; onProfile: () => void }) {
  const [, forceTime] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => forceTime((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const now = Date.now();
  const battle = snapshot.activeBattle &&
    snapshot.activeBattle.status !== "resolved" &&
    new Date(snapshot.activeBattle.endsAt).getTime() > now
    ? snapshot.activeBattle
    : null;
  const construction = snapshot.buildings
    .filter((building) => building.upgradeFinishesAt && new Date(building.upgradeFinishesAt).getTime() > now)
    .sort((a, b) => new Date(a.upgradeFinishesAt || 0).getTime() - new Date(b.upgradeFinishesAt || 0).getTime())[0];
  const election = snapshot.election?.status === "open" && new Date(snapshot.election.endsAt).getTime() > now ? snapshot.election : null;
  const readyRewards = snapshot.dailyMissions.filter((mission) => !mission.claimed && mission.progress >= mission.target).length;
  const formatLeft = (iso: string) => {
    const seconds = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 59 ? `${Math.floor(minutes / 60)}ч ${minutes % 60}м` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };
  if (!battle && !construction && !election && !readyRewards) return null;
  return <div className="world-pulse" aria-label="Текущие события государства">
    {battle && <button type="button" className="world-pulse-item danger" onClick={onBattle}><i>⚔</i><span><small>БОЙ ИДЁТ</small><b>{battle.attackerScore}:{battle.defenderScore}</b></span><em>{formatLeft(battle.endsAt)}</em></button>}
    {construction && <button type="button" className="world-pulse-item build" onClick={onIsland}><i>⌂</i><span><small>СТРОИТСЯ</small><b>{construction.label}</b></span><em>{formatLeft(construction.upgradeFinishesAt!)}</em></button>}
    {election && <button type="button" className="world-pulse-item vote" onClick={onProfile}><i>◆</i><span><small>ВЫБОРЫ</small><b>Президент</b></span><em>{formatLeft(election.endsAt)}</em></button>}
    {readyRewards > 0 && <button type="button" className="world-pulse-item reward" onClick={onProfile}><i>★</i><span><small>НАГРАДЫ</small><b>{readyRewards} готово</b></span><em>забрать</em></button>}
  </div>;
}

const MobileHeader = memo(function MobileHeader({ snapshot, online, lastSyncAt, syncing, onSync }: { snapshot: GameSnapshot; online: boolean; lastSyncAt: number; syncing: boolean; onSync: () => void }) {
  const state = snapshot.state;
  const founderIsPresident = snapshot.government.founder?.playerId === snapshot.player.id && snapshot.government.president?.playerId === snapshot.player.id;
  const role = state.isFreeport ? "Свободный игрок" : founderIsPresident ? "Основатель · Президент" : snapshot.government.founder?.playerId === snapshot.player.id ? "Основатель" : snapshot.player.role === "president" ? "Президент" : snapshot.player.role === "minister" || snapshot.player.role === "deputy" ? "Заместитель" : snapshot.player.role === "curator" ? "Куратор" : "Участник";
  const compact = (value: number) => COMPACT_FORMATTER.format(value);
  return (
    <header className="island-mobile-header game-mobile-header">
      <div className="game-header-identity">
        <span className="game-brand-rune" aria-hidden="true">WS</span>
        <span className="header-avatar game-header-avatar" style={{ background: state.color }}>{state.avatarUrl ? <Image src={state.avatarUrl} alt="" width={42} height={42} unoptimized /> : state.emblem}</span>
        <div className="header-state-name game-header-name"><b>{state.isFreeport ? "Нейтральная зона" : state.name}</b>{state.stateUsername && !state.isFreeport ? <em>@{state.stateUsername}</em> : null}<small>{role}{state.isFreeport ? " · нейтральная зона" : ` · #${state.seasonRank}`}</small></div>
        <button type="button" className={`game-sync ${online ? "online" : "offline"} ${syncing ? "syncing" : ""}`} onClick={onSync} disabled={!online || syncing} aria-label="Синхронизировать данные" title={online ? `Последняя синхронизация · ${new Date(lastSyncAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "Нет соединения"}><i />{syncing ? "SYNC" : online ? "LIVE" : "OFF"}</button>
      </div>
      <div className="game-header-stats">
        {state.isFreeport ? (
          <>
            <div className="game-stat-chip"><NavIcon type="profile" /><div><b>ур. {snapshot.player.level}</b><small>уровень</small></div></div>
            <div className="game-stat-chip"><span className="header-xp-mark">XP</span><div><b>{compact(snapshot.player.xp)}</b><small>опыт</small></div></div>
            <div className="game-stat-chip coin"><span className="coin-mark">●</span><div><b>{compact(state.memberCount)}</b><small>свободных</small></div></div>
          </>
        ) : (
          <>
            <div className="game-stat-chip"><NavIcon type="rating" /><div><b>{state.rating}</b><small>ELO</small></div></div>
            <div className="game-stat-chip"><NavIcon type="profile" /><div><b>{compact(state.memberCount)}</b><small>участников</small></div></div>
            <div className="game-stat-chip coin"><span className="coin-mark">●</span><div><b>{compact(state.treasury.credits)}</b><small>казна</small></div></div>
          </>
        )}
      </div>
    </header>
  );
});

function NavIcon({ type }: { type: View }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (type === "home") return <svg {...common}><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v5H4zM14 15h6v5h-6z"/></svg>;
  if (type === "map") return <svg {...common}><path d="M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20Z"/><path d="M9 4v13.5M15 6.5V20"/></svg>;
  if (type === "island") return <svg {...common}><path d="M4 20h16M6 20V10h12v10M8 10V6h3v4M13 10V5h3v5M9 20v-5h6v5"/><path d="M5 10h14"/></svg>;
  if (type === "battle") return <svg {...common}><path d="m6 4 5 5-6.5 6.5M18 4l-5 5 6.5 6.5"/><path d="m3.5 18.5 3-3 2 2-3 3ZM20.5 18.5l-3-3-2 2 3 3Z"/></svg>;
  if (type === "rating") return <svg {...common}><path d="M7 4h10v3.5c0 3.4-2.2 6-5 6s-5-2.6-5-6Z"/><path d="M7 6H4v2c0 2 1.3 3 3.4 3M17 6h3v2c0 2-1.3 3-3.4 3M12 13.5V18M8.5 20h7"/></svg>;
  if (type === "alliances") return <svg {...common}><path d="M7.5 13.5 4 10l3-3 3.5 3.5M16.5 13.5 20 10l-3-3-3.5 3.5"/><path d="m9.5 9.5 2.5-2 2.5 2M8.5 14.5 12 17l3.5-2.5"/></svg>;
  if (type === "strategy") return <svg {...common}><path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M9 20v-6h6v6M9 10h.01M15 10h.01"/></svg>;
  return <svg {...common}><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.8-4 3-6 6.5-6s5.7 2 6.5 6"/></svg>;
}

function SceneLoading({ label }: { label: string }) {
  return <div className="scene-loading"><i /><span>{label}</span></div>;
}
