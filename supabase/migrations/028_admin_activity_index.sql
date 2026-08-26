-- WARSTATE: index to support fast time-windowed activity aggregation
-- (used by the admin panel's "bot activity" counters, and any future
-- per-day/per-hour analytics on contribution_events).
-- Additive only: no data changes, no locks beyond a normal CREATE INDEX.

create index if not exists idx_contribution_events_source_created
  on public.contribution_events(source, created_at desc);
