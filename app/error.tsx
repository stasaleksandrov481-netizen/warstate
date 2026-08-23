"use client";

export default function ErrorScreen({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="fatal-screen ws-fatal"><div className="ws-splash-orbit"><div className="logo-mark">GW</div></div><small>СБОЙ СВЯЗИ</small><h1>Штаб временно недоступен</h1><p>Интерфейс остановился, но игровой прогресс хранится на сервере. Экран можно безопасно перезапустить.</p><button type="button" className="primary" onClick={reset}>Перезапустить</button></main>;
}
