# WARSTATE v4.0 — stability & world-fit hardening

- Fixed Telegram admin deep-link race: `start_param=admin` is detected from initData, URL/hash, and briefly re-checked after the SDK appears before normal bootstrap.
- Fixed world-fit rendering cap: far LOD no longer hides states after the first 240 entries.
- Increased client island merge ceiling to 520 to match the database world-read ceiling.
- Fixed battle snapshot updates to use functional React state, preventing realtime refreshes from overwriting newer snapshot fields.
- Hardened active-battle lookup so expired/resolved battles cannot reappear as the persistent LIVE event after a full state refresh.
