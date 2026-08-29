"use client";

import { useEffect, useState } from "react";

type Props = { initData: string };
type Status = { enabled: boolean; reason: string | null; updatedAt: string | null };

const REASONS = [
  "Технические работы",
  "Обновление WARSTATE",
  "Профилактика и обслуживание",
  "Временные неполадки",
  "По решению администрации",
  "Без причины",
];

export function AdminBotControl({ initData }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reasonMode, setReasonMode] = useState(REASONS[0]);
  const [customReason, setCustomReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/bot-status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-init-data": initData },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.error || `Ошибка сервера (${response.status})`);
    return json as Status;
  }

  useEffect(() => {
    let cancelled = false;
    void call({ action: "status" }).then((next) => { if (!cancelled) setStatus(next); }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Не удалось получить статус бота"); });
    return () => { cancelled = true; };
  }, [initData]);

  async function toggle(nextEnabled: boolean) {
    if (busy) return;
    const reason = reasonMode === "Без причины" ? null : reasonMode === "" ? customReason.trim() || null : reasonMode === "Своя причина" ? customReason.trim() || null : reasonMode;
    if (!nextEnabled && reasonMode === "Своя причина" && !reason) {
      setError("Введите причину отключения или выберите готовый вариант.");
      return;
    }
    const confirmText = nextEnabled
      ? "Открыть WARSTATE для всех игроков?"
      : `Остановить бота для всех игроков${reason ? `?\n\nПричина: ${reason}` : " без указания причины?"}`;
    if (!window.confirm(confirmText)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await call({ action: "set", enabled: nextEnabled, reason });
      setStatus(next);
      setNotice(next.enabled ? "WARSTATE снова доступен для игроков." : "Бот остановлен. Новые сообщения и игровые действия заблокированы.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить режим бота");
    } finally { setBusy(false); }
  }

  return (
    <section className="admin-bot-control panel">
      <div className="admin-bot-head">
        <div>
          <small>ГЛОБАЛЬНЫЙ РЕЖИМ</small>
          <h3>⏸ Управление ботом</h3>
          <p>Остановка действует одновременно в Telegram-группах, личке и Mini App. Администратор сохраняет доступ к панели.</p>
        </div>
        <b className={status?.enabled ? "open" : "closed"}>{status ? (status.enabled ? "РАБОТАЕТ" : "ЗАКРЫТ") : "…"}</b>
      </div>

      <div className="admin-bot-preview">
        <span>{status?.enabled ? "●" : "⏸"}</span>
        <div><strong>{status?.enabled ? "Бот принимает команды" : "Бот временно закрыт"}</strong><small>{status?.reason ? `Причина: ${status.reason}` : status?.enabled ? "Игроки могут пользоваться игрой как обычно." : "Причина не указана."}</small></div>
      </div>

      <div className="admin-bot-reason">
        <label><span>Причина при закрытии</span>
          <select value={reasonMode} onChange={(e) => setReasonMode(e.target.value)} disabled={busy}>
            {REASONS.map((item) => <option key={item}>{item}</option>)}
            <option>Своя причина</option>
          </select>
        </label>
        {reasonMode === "Своя причина" && <label><span>Текст причины</span><textarea value={customReason} onChange={(e) => setCustomReason(e.target.value)} maxLength={500} rows={3} placeholder="Например: обновляем боевую систему и исправляем ошибки…" disabled={busy} /></label>}
      </div>

      <div className="admin-bot-actions">
        <button type="button" className="danger" disabled={busy || status?.enabled === false} onClick={() => void toggle(false)}>{busy ? "Сохраняю…" : "⏸ Остановить бота"}</button>
        <button type="button" className="success" disabled={busy || status?.enabled === true} onClick={() => void toggle(true)}>{busy ? "Сохраняю…" : "▶ Открыть бота"}</button>
      </div>
      {notice && <div className="admin-action-status success">{notice}</div>}
      {error && <div className="admin-action-status error">{error}</div>}
    </section>
  );
}
