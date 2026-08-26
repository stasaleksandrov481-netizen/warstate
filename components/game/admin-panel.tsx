"use client";

import { useCallback, useEffect, useState } from "react";

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

export function AdminPanel({ initData }: Props) {
  const [stats, setStats] = useState<AdminStatsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
    app?.setHeaderColor?.("#0b2730");
    app?.setBackgroundColor?.("#0b2730");
    void load();
  }, [load]);

  return (
    <main className="app-shell" style={{ background: "#0b2730", overflowY: "auto", paddingBottom: 24 }}>
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
