-- WARSTATE v2.1 — fix low-contrast numbers/letters on the per-state color.
--
-- states.color was generated as hsl(hue, 72%, 52%). The UI always overlays
-- fixed light/white text and digits on top of this color (state emblem,
-- island avatar initial, ranking emblem, relation marks, home hero badge).
-- At 52% lightness, light hues (yellow, cyan, light green) are bright
-- enough that light text on top becomes very hard to read — this is the
-- "numbers hard to see against the background" complaint.
--
-- lib/government.ts now generates new states at hsl(hue, 62%, 34%), which
-- stays readably dark across every hue. Recompute existing rows the same
-- way so already-registered states get the same fix, using the same hue
-- (derived from telegram_chat_id) they were originally assigned.
update public.states
set color = 'hsl(' || (abs(telegram_chat_id) % 360) || ' 62% 34%)'
where telegram_chat_id is not null
  and color ~ '^hsl\(\d+ 72% 52%\)$';
