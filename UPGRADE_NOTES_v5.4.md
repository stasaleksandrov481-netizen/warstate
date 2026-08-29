# WARSTATE v5.4.0 upgrade notes

## Required database migration

Apply migrations in order and make sure the new migration is applied before deploying the v5.4 application code:

`supabase/migrations/040_personal_economy_v54.sql`

The migration is mandatory. The Mini App snapshot intentionally does not hide a missing v5.4 economy RPC behind mock or fallback data.

## What migration 040 adds

- personal player coins and personal Steel / Fuel / Food / Tech inventory;
- two-hour personal gathering cooldown;
- role-based gathering for Miner, Worker, Spy and Diplomat;
- 25-use tools and gathering consumables;
- personal House with hourly coin income;
- Baron / Count / Magnate titles;
- personal coin investment into state ELO;
- Spy wild-land raid;
- state economy sleeping mode;
- hard 50-unit humanitarian floor on all state treasury resources;
- reserve-aware construction, repair and legacy espionage;
- personal economy audit log.

## Deployment sequence

1. Apply migration `040_personal_economy_v54.sql` in Supabase.
2. Deploy the v5.4 application.
3. Run `npm run audit:project`.
4. Run `npm run typecheck` and `npm run build` in an environment where npm dependencies are installed.
5. In a test state, verify `!добыча`, `!сдать`, `!магазин`, `!титул`, `!инвестировать`, `!кража`, `!разведка` and the interactive `!помощь` menu.
6. Open the Mini App map, pan/zoom rapidly, open a state card, enter Castle, return to Map, and verify the Canvas redraws without a black frame.

## Economy compatibility

Passive state production in v5.4 creates Credits only. Steel, Fuel, Food and Tech are citizen-driven and primarily enter the state treasury through `!сдать`.
