-- WARSTATE v5 / continent redesign compatibility migration
-- Keeps legacy island_* columns intact while introducing state-local time for
-- scheduling UI and Telegram emergency events.

alter table public.states
  add column if not exists time_zone text not null default 'Europe/Moscow';

comment on column public.states.time_zone is
  'IANA timezone used for state-local scheduled events, e.g. Europe/Moscow.';

-- Existing next_threat_at values may still point at the previous 3-hour cadence.
-- Reset them so the runtime arms the next 5-hour slot (08:00 / 13:00 / 18:00).
update public.states
set next_threat_at = null
where bot_present = true
  and is_freeport = false
  and is_beginner_island = false;

-- Remove the last marine label from the active activity data without changing
-- the stable option key used by existing clients and run history.
update public.activity_templates
set options = (
  select jsonb_agg(
    case
      when item->>'key' = 'speed' then jsonb_set(item, '{label}', to_jsonb('Быстрый транспорт'::text))
      else item
    end
  )
  from jsonb_array_elements(options) as item
)
where key = 'supply_run';
