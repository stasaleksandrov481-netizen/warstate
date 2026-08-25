# WARSTATE 3.8

1. Apply `supabase/migrations/026_global_project_admin_and_chat_join.sql`.
2. Keep the creator Telegram ID in `WARSTATE_PROJECT_ADMIN_TELEGRAM_IDS`.
3. In any WARSTATE group, creator runs `!суперадмин` once to activate full command authority for that chat.
4. Disable with `!суперадмин выкл`.
5. President can manage deputies in chat and Mini App.
6. Citizens can join the current state's group with `!вступить`; newly joined Telegram users are automatically enrolled on join events.
