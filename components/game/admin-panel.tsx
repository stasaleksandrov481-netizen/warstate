"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminRewardsCenter } from "@/components/game/admin-rewards-center";
import { AdminBotControl } from "@/components/game/admin-bot-control";

export interface AdminStatsView {
  generatedAt: string;
  states: { total: number; newLast7d: number };
  players: { total: number; active24h: number; active7d: number; newLast7d: number };
  battles: { total: number; last24h: number };
  botActivity: { updates24h: number; updates7d: number; activityEvents24h: number };
  payments: {
    count: number;
    starsTotal: number;
    starsLast7d: number;
    recent: Array<{ sku: string; stars: number; createdAt: string; playerName: string | null }>;
  };
  topStates: Array<{ name: string; rating: number; activePlayerCount: number; telegramChatId: number }>;
}

type Props = {
  initData: string;
};

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" style={{ minWidth: 0 }}>
      <small>{label}</small>
      <strong>{value}</strong>
      {hint ? <span style={{ display: "block", fontSize: 9, color: "var(--muted)", marginTop: 4 }}>{hint}</span> : null}
    </div>
  );
}

function formatRu(value: number) {
  return value.toLocaleString("ru-RU");
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

interface BroadcastResult {
  targeted: number;
  sent: number;
  failed: number;
  failedChats: Array<{ name: string; error: string }>;
}

interface BroadcastTarget {
  id: string;
  name: string;
  stateUsername: string | null;
  telegramChatId: number;
}

export function AdminPanel({ initData }: Props) {
  const [stats, setStats] = useState<AdminStatsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [broadcastResult, setBroadcastResult] = useState<BroadcastResult | null>(null);
  const [broadcastSigned, setBroadcastSigned] = useState(true);
  const [broadcastMode, setBroadcastMode] = useState<"all" | "select">("all");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetResults, setTargetResults] = useState<BroadcastTarget[]>([]);
  const [targetSearching, setTargetSearching] = useState(false);
  const [selectedTargets, setSelectedTargets] = useState<Map<string, BroadcastTarget>>(new Map());

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/stats", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-init-data": initData },
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error || `Ошибка сервера (${response.status})`);
      setStats(json as AdminStatsView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить статистику");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [initData]);

  useEffect(() => {
    const app = (typeof window !== "undefined" ? (window as any).Telegram?.WebApp : null) || null;
    app?.ready?.();
    app?.expand?.();
    app?.setHeaderColor?.("#1d1c17");
    app?.setBackgroundColor?.("#1d1c17");
    void load();
  }, [load]);

  useEffect(() => {
    if (broadcastMode !== "select") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setTargetSearching(true);
      try {
        const response = await fetch("/api/admin/broadcast-targets", {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-init-data": initData },
          body: JSON.stringify({ query: targetQuery }),
          cache: "no-store",
        });
        const json = await response.json().catch(() => null);
        if (!cancelled && response.ok) setTargetResults((json?.targets as BroadcastTarget[]) || []);
      } catch {
        // Silent: the search box just stays empty, the panel remains usable.
      } finally {
        if (!cancelled) setTargetSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [broadcastMode, targetQuery, initData]);

  const toggleTarget = useCallback((target: BroadcastTarget) => {
    setSelectedTargets((prev) => {
      const next = new Map(prev);
      if (next.has(target.id)) next.delete(target.id); else next.set(target.id, target);
      return next;
    });
  }, []);

  const sendBroadcast = useCallback(async () => {
    const text = broadcastText.trim();
    if (!text || broadcasting) return;
    const stateIds = broadcastMode === "select" ? [...selectedTargets.keys()] : undefined;
    if (broadcastMode === "select" && !stateIds!.length) {
      setBroadcastError("Выберите хотя бы один чат.");
      return;
    }
    const confirmLabel = broadcastMode === "select"
      ? `Отправить это сообщение в ${stateIds!.length} выбранных чатов?`
      : `Отправить это сообщение во все ${stats?.states.total ?? ""} чатов государств?`;
    if (!window.confirm(confirmLabel)) return;
    setBroadcasting(true);
    setBroadcastError(null);
    setBroadcastResult(null);
    try {
      const response = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ text, stateIds, signed: broadcastSigned }),
        cache: "no-store",
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(json?.error || `Ошибка сервера (${response.status})`);
      setBroadcastResult(json as BroadcastResult);
      setBroadcastText("");
      setSelectedTargets(new Map());
    } catch (e) {
      setBroadcastError(e instanceof Error ? e.message : "Не удалось отправить рассылку");
    } finally {
      setBroadcasting(false);
    }
  }, [broadcastText, broadcasting, broadcastMode, selectedTargets, broadcastSigned, initData, stats?.states.total]);

  return (
    <main className="app-shell" style={{ background: "#1d1c17", overflowY: "auto", paddingBottom: 24 }}>
      <div className="topbar" style={{ position: "sticky", top: 0, zIndex: 5, background: "rgba(11,39,48,.92)" }}>
        <div className="brand">
          <div className="brand-mark">🛠</div>
          <strong>Админ-панель WARSTATE</strong>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 10, padding: "6px 10px", fontSize: 11 }}
        >
          {refreshing ? "…" : "Обновить"}
        </button>
      </div>

      {loading && !stats && (
        <div className="panel"><p>Загружаем статистику…</p></div>
      )}

      {error && (
        <div className="panel">
          <h3>Ошибка</h3>
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            style={{ marginTop: 10, border: 0, borderRadius: 10, background: "var(--accent)", color: "#fff", padding: "9px 14px", fontSize: 12, fontWeight: 700 }}
          >
            Повторить
          </button>
        </div>
      )}

      <AdminBotControl initData={initData} />
      <AdminRewardsCenter initData={initData} />

      {stats && (
        <>
          <div className="section-title">
            <div>
              <small>ОБНОВЛЕНО</small>
              <h2 style={{ fontSize: 16 }}>{formatTime(stats.generatedAt)}</h2>
            </div>
          </div>

          <div className="panel">
            <h3><span>ГОСУДАРСТВА</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <StatCard label="Всего групп" value={formatRu(stats.states.total)} />
              <StatCard label="Новых за 7д" value={formatRu(stats.states.newLast7d)} />
            </div>
          </div>

          <div className="panel">
            <h3><span>РАССЫЛКА В ЧАТЫ</span></h3>
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
              Государства, из которых бот был исключён, автоматически пропускаются.
            </p>

            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button
                type="button"
                onClick={() => setBroadcastMode("all")}
                style={{
                  flex: 1, border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", fontSize: 11, fontWeight: 700,
                  background: broadcastMode === "all" ? "var(--accent)" : "transparent",
                  color: broadcastMode === "all" ? "#fff" : "var(--text)",
                }}
              >
                Все чаты
              </button>
              <button
                type="button"
                onClick={() => setBroadcastMode("select")}
                style={{
                  flex: 1, border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", fontSize: 11, fontWeight: 700,
                  background: broadcastMode === "select" ? "var(--accent)" : "transparent",
                  color: broadcastMode === "select" ? "#fff" : "var(--text)",
                }}
              >
                Выбрать чаты
              </button>
            </div>

            {broadcastMode === "select" && (
              <div style={{ marginTop: 10 }}>
                {selectedTargets.size > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                    {[...selectedTargets.values()].map((target) => (
                      <button
                        key={target.id}
                        type="button"
                        onClick={() => toggleTarget(target)}
                        style={{ border: "1px solid var(--accent)", borderRadius: 999, padding: "4px 10px", fontSize: 10.5, background: "rgba(255,255,255,.06)", color: "var(--text)" }}
                      >
                        {target.name} ✕
                      </button>
                    ))}
                  </div>
                )}
                <input
                  value={targetQuery}
                  onChange={(e) => setTargetQuery(e.target.value)}
                  placeholder="Поиск государства по названию или @юзу…"
                  style={{
                    width: "100%", borderRadius: 10, border: "1px solid var(--line)", background: "rgba(255,255,255,.04)",
                    color: "var(--text)", padding: 9, fontSize: 12.5, fontFamily: "inherit",
                  }}
                />
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                  {targetSearching && <p style={{ fontSize: 11, color: "var(--muted)" }}>Ищем…</p>}
                  {!targetSearching && targetResults.length === 0 && (
                    <p style={{ fontSize: 11, color: "var(--muted)" }}>
                      {targetQuery.trim() ? "Ничего не найдено." : "Начните вводить название государства."}
                    </p>
                  )}
                  {targetResults.map((target) => {
                    const checked = selectedTargets.has(target.id);
                    return (
                      <label
                        key={target.id}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                          border: "1px solid var(--line)", borderRadius: 10, padding: "7px 10px", fontSize: 12,
                          background: checked ? "rgba(255,255,255,.06)" : "transparent", cursor: "pointer",
                        }}
                      >
                        <span>{target.name}{target.stateUsername ? <span style={{ color: "var(--muted)" }}> · @{target.stateUsername}</span> : null}</span>
                        <input type="checkbox" checked={checked} onChange={() => toggleTarget(target)} />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 12 }}>
              <input type="checkbox" checked={broadcastSigned} onChange={(e) => setBroadcastSigned(e.target.checked)} />
              Подписать «От администрации WARSTATE»
            </label>

            <textarea
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="Текст сообщения…"
              rows={4}
              disabled={broadcasting}
              style={{
                width: "100%",
                marginTop: 10,
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "rgba(255,255,255,.04)",
                color: "var(--text)",
                padding: 10,
                fontSize: 13,
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>{broadcastText.length}/3500</span>
              <button
                type="button"
                onClick={() => void sendBroadcast()}
                disabled={broadcasting || !broadcastText.trim() || (broadcastMode === "select" && selectedTargets.size === 0)}
                style={{
                  border: 0,
                  borderRadius: 10,
                  background: broadcasting || !broadcastText.trim() ? "rgba(255,255,255,.08)" : "var(--accent)",
                  color: "#fff",
                  padding: "9px 16px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {broadcasting ? "Отправка…" : broadcastMode === "select" ? `Отправить (${selectedTargets.size})` : "Отправить всем"}
              </button>
            </div>
            {broadcastError && (
              <p style={{ marginTop: 10, fontSize: 12, color: "#e98270" }}>{broadcastError}</p>
            )}
            {broadcastResult && (
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <p>
                  Отправлено: <b>{broadcastResult.sent}</b> из {broadcastResult.targeted}
                  {broadcastResult.failed > 0 ? ` · ошибок: ${broadcastResult.failed}` : ""}
                </p>
                {broadcastResult.failedChats.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                    {broadcastResult.failedChats.slice(0, 8).map((item, index) => (
                      <span key={index} style={{ color: "var(--muted)" }}>
                        ⚠️ {item.name} — {item.error}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            <h3><span>ИГРОКИ</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <StatCard label="Всего игроков" value={formatRu(stats.players.total)} />
              <StatCard label="Новых за 7д" value={formatRu(stats.players.newLast7d)} />
              <StatCard label="Активны 24ч" value={formatRu(stats.players.active24h)} />
              <StatCard label="Активны 7д" value={formatRu(stats.players.active7d)} />
            </div>
          </div>

          <div className="panel">
            <h3><span>АКТИВНОСТЬ БОТА</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <StatCard label="Событий за 24ч" value={formatRu(stats.botActivity.updates24h)} hint="сообщения и действия в боте" />
              <StatCard label="Событий за 7д" value={formatRu(stats.botActivity.updates7d)} />
              <StatCard label="Игровых действий 24ч" value={formatRu(stats.botActivity.activityEvents24h)} />
              <StatCard label="Битв за 24ч" value={formatRu(stats.battles.last24h)} />
            </div>
          </div>

          <div className="panel">
            <h3><span>БИТВЫ</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <StatCard label="Всего битв" value={formatRu(stats.battles.total)} />
              <StatCard label="За 24ч" value={formatRu(stats.battles.last24h)} />
            </div>
          </div>

          <div className="panel">
            <h3><span>ПЛАТЕЖИ (STARS)</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <StatCard label="Всего платежей" value={formatRu(stats.payments.count)} />
              <StatCard label="Всего Stars" value={formatRu(stats.payments.starsTotal)} />
              <StatCard label="Stars за 7д" value={formatRu(stats.payments.starsLast7d)} />
            </div>
            {stats.payments.recent.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {stats.payments.recent.map((payment, index) => (
                  <div key={index} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                    <span style={{ color: "var(--muted)" }}>{payment.playerName || "—"} · {payment.sku}</span>
                    <b>{formatRu(payment.stars)}⭐</b>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h3><span>ТОП ГОСУДАРСТВ ПО РЕЙТИНГУ</span></h3>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {stats.topStates.map((state, index) => (
                <div key={state.telegramChatId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <span>#{index + 1} {state.name}</span>
                  <span style={{ color: "var(--muted)" }}>{formatRu(state.rating)} · {state.activePlayerCount} игр.</span>
                </div>
              ))}
              {stats.topStates.length === 0 && <p>Пока нет данных.</p>}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
