# WARSTATE v5.4.1 upgrade notes

1. Разверните код v5.4.1.
2. В Supabase примените миграции по порядку. Для обновления с v5.4.0 обязательно применить `041_release_candidate_audit.sql`.
3. Проверьте обязательные Telegram/Supabase environment variables.
4. Выполните `npm ci`, `npm run audit:project`, `npm run typecheck`, `npm run build`.
5. Проверьте в Telegram: карту после background/foreground, `!добыча`, `!сдать`, `!магазин`, `!титул`, ЧП и приватный admin access Reply-flow.

Миграция 041 не создаёт новую экономику заново. Она исправляет инварианты v5.4 и отменяет legacy auto-invite rows приватных групп.
