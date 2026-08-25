# WARSTATE v1.9.0 — Government System Audit

## State registration

When the bot joins a Telegram group/supergroup, WARSTATE reads the chat metadata and administrators, verifies the Telegram `creator`, creates the state if necessary and records the creator as Founder. Existing legacy states without a verified founder are repaired on registration.

New states begin with:

- Level: 1
- Budget: 1000
- Influence: 100
- Technology: 50
- Reputation: 100
- Army: 100
- Defense: 120

The v1.9 strategy refresh treats level-1 buildings as the baseline so these army/defense values are not immediately inflated after the first tick.

## Government roles

- Founder: permanent Telegram chat creator; can manage president, deputies, elections, public state name and state username.
- President: war, diplomacy and development leadership.
- Deputy: war, alliance acceptance, building upgrades and military actions.
- Citizen: normal participation and voting.
- Deputy cap: 3, enforced server-side in SQL.

Founder is intentionally separate from President. If a legacy `owner_player_id` points at the verified Founder, v1.9 clears that legacy presidency instead of silently assigning two offices to the same field.

## Elections

- Duration: 30 minutes.
- Founder opens an election.
- Citizens vote by Telegram username.
- One active vote per citizen; vote can be changed while polls are open.
- The highest vote count wins; deterministic candidate creation time is used as the tie ordering.
- Election cron runs once per minute and finalizes expired elections.
- Founder/curator cannot become an election candidate.

## State username

- 4–32 characters.
- English lowercase letters, digits and underscore.
- Case-insensitive uniqueness.
- Founder-only creation/change.
- Change cooldown after assignment: 30 days.
- Used by war, alliance, reconnaissance, search and diplomacy targeting.

## Chat activity

A normal group message awards +2 player XP and +1 state contribution. The database enforces a one-minute cooldown per player so duplicate webhook deliveries or spam do not multiply the reward.

## Shared chat/Mini App logic

War creation goes through `startWarAction` from both the Telegram command and Mini App API. Building upgrades go through `upgradeBuildingAction`. Government actions share `lib/government.ts` between chat commands and `/api/game/government`.

## Requested command coverage

Information, politics, economy, war, alliances, activities, profile, state search/name/username commands from the v1.9 specification are recognized by the Telegram command handler.
