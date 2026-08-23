"use client";

export default function ErrorScreen({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="fatal-screen"><div className="logo-mark">GW</div><small>СБОЙ СВЯЗИ</small><h1>Штаб временно недоступен</h1><p>Клиент поймал ошибку интерфейса. Прогресс хранится на сервере, поэтому можно безопасно перезапустить экран.</p><button type="button" className="primary" onClick={reset}>Перезапустить</button></main>;
}
