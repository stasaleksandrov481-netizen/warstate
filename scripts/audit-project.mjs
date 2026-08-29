import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const notes = [];
const sourceRoots = ["app", "components", "lib", "scripts"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);

function walk(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (["node_modules", ".next", ".git", ".vercel"].includes(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const projectFiles = sourceRoots.flatMap(walk).filter((file, index, all) => all.indexOf(file) === index);
const sourceFiles = projectFiles.filter((file) => sourceExtensions.has(path.extname(file)));

function resolveLocal(fromFile, specifier) {
  const base = specifier.startsWith("@/")
    ? path.join(root, specifier.slice(2))
    : path.resolve(root, path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

const importPattern = /(?:from\s+|import\s*\()(["'])(@\/[^"']+|\.{1,2}\/[^"']+)\1/g;
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(importPattern)) {
    if (!resolveLocal(file, match[2])) failures.push(`Missing local import: ${file} -> ${match[2]}`);
  }
}

const envExamplePath = path.join(root, ".env.example");
const envExample = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, "utf8") : "";
const documentedEnv = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
const referencedEnv = new Set();
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) referencedEnv.add(match[1]);
}
for (const key of referencedEnv) if (key !== "NODE_ENV" && !documentedEnv.has(key)) failures.push(`ENV is used but missing from .env.example: ${key}`);

for (const forbidden of [".env", ".env.local", ".next", "node_modules", ".vercel", "lib/demo.ts", "app/api/game/attack/route.ts"]) {
  if (fs.existsSync(path.join(root, forbidden))) failures.push(`Forbidden/legacy path present: ${forbidden}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.name !== "warstate") failures.push(`Unexpected package name: ${packageJson.name}`);
if (String(packageJson.version || "") !== "5.4.2") failures.push(`Expected v5.4.2 package version, found ${packageJson.version}`);

const requiredV20 = [
  "supabase/migrations/043_release_final_hardening.sql",
  "supabase/migrations/042_release_polish.sql",
  "supabase/migrations/041_release_candidate_audit.sql",
  "supabase/migrations/040_personal_economy_v54.sql",
  "supabase/migrations/039_interstate_messages.sql",
  "supabase/migrations/035_admin_rewards_medals_access.sql",
  "supabase/migrations/034_continent_redesign.sql",
  "supabase/migrations/015_event_driven_runtime.sql",
  "supabase/migrations/016_member_activity_votes_spy.sql",
  "supabase/migrations/017_telegram_update_claim_lease.sql",
  "supabase/migrations/018_state_switch_delete_ui.sql",
  "supabase/migrations/023_founder_president_admin.sql",
  "supabase/migrations/024_repair_government_commands.sql",
  "supabase/migrations/025_compact_world_and_map_repair.sql",
  "app/api/game/state/switch/route.ts",
  "lib/community.ts",
  "lib/maintenance.ts",
  "lib/government.ts",
  "lib/actions.ts",
  "app/api/game/government/route.ts",
  "app/api/game/runtime/route.ts",
];
for (const rel of requiredV20) if (!fs.existsSync(path.join(root, rel))) failures.push(`Missing v2.0 file: ${rel}`);

const vercelPath = path.join(root, "vercel.json");
if (fs.existsSync(vercelPath)) {
  const vercel = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  if (Array.isArray(vercel.crons) && vercel.crons.length) failures.push("vercel.json still contains scheduled crons; v2.0 must be event-driven by default");
}


const webhookSource = fs.readFileSync(path.join(root, "app/api/telegram/webhook/route.ts"), "utf8");
if (!webhookSource.includes("gw_claim_telegram_update_v2")) failures.push("Crash-safe Telegram webhook idempotency claim is missing");
if (!webhookSource.includes("gw_complete_telegram_update")) failures.push("Telegram webhook completion receipt is missing");
const runtimeMigration = fs.readFileSync(path.join(root, "supabase/migrations/015_event_driven_runtime.sql"), "utf8");
if (!runtimeMigration.includes("telegram_update_receipts")) failures.push("Telegram update receipt table is missing from migration 015");
if (!runtimeMigration.includes("gw_claim_state_maintenance")) failures.push("Event-driven maintenance lease RPC is missing from migration 015");

const nextConfigSource = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
for (const header of ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) {
  if (!nextConfigSource.includes(header)) failures.push(`Security header missing from next.config.ts: ${header}`);
}
if (!nextConfigSource.includes("poweredByHeader: false")) failures.push("Next.js X-Powered-By header is still enabled");

// Every application RPC must exist in the migration set. This catches a very
// common production failure before it reaches Supabase/PostgREST.
const referencedRpc = new Set();
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g)) referencedRpc.add(match[1]);
}
const migrationFiles = walk("supabase/migrations").filter((file) => file.endsWith(".sql"));
const definedRpc = new Set();
for (const file of migrationFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) definedRpc.add(match[1]);
}
for (const rpc of referencedRpc) if (!definedRpc.has(rpc)) failures.push(`RPC used by app but missing from migrations: ${rpc}`);

// Validate named Supabase RPC arguments against the latest migration definition.
// PostgREST resolves RPCs by argument names, so a harmless-looking rename such
// as sid -> p_state_id can otherwise break every matching command in production.
const rpcDefinitions = new Map();
for (const file of migrationFiles.sort()) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\b/gi;
  for (const match of text.matchAll(pattern)) {
    const params = [];
    const optional = new Set();
    for (const rawPart of match[2].split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const tokens = part.split(/\s+/);
      const offset = ["in", "out", "inout", "variadic"].includes(String(tokens[0] || "").toLowerCase()) ? 1 : 0;
      const name = tokens[offset];
      if (!name) continue;
      params.push(name);
      if (/\bdefault\b|:=/i.test(part)) optional.add(name);
    }
    const definitions = rpcDefinitions.get(match[1]) || [];
    definitions.push({ params, optional, file });
    rpcDefinitions.set(match[1], definitions);
  }
}
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const calls = [
    ...text.matchAll(/\.rpc\(\s*["']([a-zA-Z0-9_]+)["']\s*,\s*\{([\s\S]*?)\}\s*\)/g),
  ];
  for (const call of calls) {
    const definitions = rpcDefinitions.get(call[1]);
    if (!definitions?.length) continue;
    const keys = [...call[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)].map((m) => m[1]);
    const matches = definitions.some((definition) => {
      const unknown = keys.filter((key) => !definition.params.includes(key));
      const missing = definition.params.filter((name) => !keys.includes(name) && !definition.optional.has(name));
      return unknown.length === 0 && missing.length === 0;
    });
    if (!matches) {
      const latest = definitions[definitions.length - 1];
      const unknown = keys.filter((key) => !latest.params.includes(key));
      const missing = latest.params.filter((name) => !keys.includes(name) && !latest.optional.has(name));
      failures.push(`RPC argument mismatch: ${file} -> ${call[1]} (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"}; latest: ${latest.file})`);
    }
  }
}

const communityMigration = fs.readFileSync(path.join(root, "supabase/migrations/016_member_activity_votes_spy.sql"), "utf8");
for (const marker of ["duty_role", "state_votes", "state_vote_ballots", "spy_quests", "gw_resolve_spy_quest", "chat_message_progress"]) {
  if (!communityMigration.includes(marker)) failures.push(`Migration 016 is missing community mechanic: ${marker}`);
}
if (!webhookSource.includes('["group", "supergroup"].includes(message.chat.type)')) failures.push("Telegram webhook must handle both group and supergroup chats");
if (/РЕСУРСЫ ЗА АКТИВНОСТЬ|Чат нафармил|10 сообщений граждан/.test(webhookSource)) failures.push("Chat activity resource notification must stay silent");
if (!webhookSource.includes("handleGroupTextCommand(message)")) failures.push("Telegram group command handler is not wired into webhook");
if (!webhookSource.includes('ignored: "unknown_bang_command"')) failures.push("Unknown !commands are not hard-stopped in Telegram webhook");
if (!webhookSource.includes('p_lease_seconds: 75')) failures.push("Telegram update receipt claim lease must exceed the 60s webhook maxDuration");
if (!webhookSource.includes('WARSTATE_RUNTIME=5.4.2-release-polish')) failures.push("Runtime version marker is missing from Telegram webhook logs");
if (webhookSource.includes("processing without receipt claim") || webhookSource.includes("fail open so group commands still work")) failures.push("Telegram update idempotency regressed to fail-open behavior");
if (!webhookSource.includes('claimStatus === "processing"') || !webhookSource.includes('status: 500')) failures.push("In-flight Telegram update retries can be acknowledged too early");
if (webhookSource.includes("bot-removed state hide skipped") || webhookSource.includes("chat_member leave mark skipped")) failures.push("Critical Telegram membership state changes are still best-effort");
if (!webhookSource.includes('observeTelegramGroupMember')) failures.push("Telegram member observation is not wired into webhook");
const stableMigration = fs.readFileSync(path.join(root, "supabase/migrations/027_webhook_idempotency_and_presence.sql"), "utf8");
for (const marker of ["telegram_chat_members", "gw_claim_telegram_update", "update public.state_members", "uq_state_members_one_home"]) {
  if (!stableMigration.includes(marker)) failures.push(`Stable webhook migration is missing: ${marker}`);
}

const gameSource = fs.readFileSync(path.join(root, "lib/game.ts"), "utf8");
const communitySource = fs.readFileSync(path.join(root, "lib/community.ts"), "utf8");
if (!gameSource.includes("getPlayerMemberSnapshot") || !gameSource.includes("isMissingDutyRoleError")) failures.push("Mini App bootstrap lacks duty-role migration compatibility");
if (!communitySource.includes("if (error && isMissingDutyRoleError(error)) return rates")) failures.push("Workforce production must tolerate a rolling duty_role migration");
const islandSource = fs.readFileSync(path.join(root, "lib/islands.ts"), "utf8");
if (!islandSource.includes('.eq("is_beginner_island", true)')) failures.push("Beginner island is not force-included in world map data");
if (!islandSource.includes("direct state query is a safe read-only fallback") || !islandSource.includes('String(row.id) === String(stateId)')) failures.push("Island world lacks RPC fallback or own-island injection");
if (!islandSource.includes("Freeport is the second global landmark")) failures.push("Freeport is not force-included as a global map landmark");
const islandMapSource = fs.readFileSync(path.join(root, "components/game/island-map.tsx"), "utf8");
for (const marker of ["buildRenderItems", "markerSize", "startInertia", "CLICK_THRESHOLD_TOUCH", 'replace(/^@/, "")', "Юз государства не создан"]) {
  if (!islandMapSource.includes(marker)) failures.push(`Continental map UX is missing: ${marker}`);
}
if (/needTerrainRepaint|terrainCanvasRef|terrainKeyRef/.test(islandMapSource)) failures.push("Continental map still contains broken legacy terrain cache code");
for (const marker of ["const MIN_ZOOM = 0.045", "screen space", "clusterCount", "gestureRef.current.pinched", "TerrainBufferCache", "getMapSpriteAtlas", "contextlost"]) {
  if (!islandMapSource.includes(marker)) failures.push(`Map scale/performance hardening is missing: ${marker}`);
}
const compactWorldMigration = fs.readFileSync(path.join(root, "supabase/migrations/025_compact_world_and_map_repair.sql"), "utf8");
for (const marker of ["520.0", "row_number() over", "new.island_slot", "trg_gw_place_island"]) {
  if (!compactWorldMigration.includes(marker)) failures.push(`Compact-world migration is missing: ${marker}`);
}
if (/greatest\s*\(\s*1\s*,\s*new\.island_slot\s*-\s*1/i.test(compactWorldMigration)) failures.push("Compact-world placement still overlaps island slots 1 and 2");
const telegramBotSource = fs.readFileSync(path.join(root, "lib/telegram-bot.ts"), "utf8");
if (!telegramBotSource.includes('getChatMember') || !telegramBotSource.includes('createStateJoinLink')) failures.push("Telegram membership gate or invite-link fallback is missing");
if (!telegramBotSource.includes('assertTelegramChatOwner')) failures.push("Telegram owner gate for state deletion is missing");
const stateSwitchSource = fs.readFileSync(path.join(root, "app/api/game/state/switch/route.ts"), "utf8");
if (!stateSwitchSource.includes("assertTelegramChatMembership") || !stateSwitchSource.includes("gw_switch_player_state")) failures.push("Explicit state switch membership gate is incomplete");
const themeSource = fs.readFileSync(path.join(root, "app/game-theme.css"), "utf8");
if (/\.game-world-layer\{[^}]*contain\s*:\s*layout style paint/i.test(themeSource)) failures.push("World layer still clips island nodes with paint containment");
if (!themeSource.includes(".game-island-node{contain:layout style!important;overflow:visible!important}")) failures.push("Island node overflow-clipping repair is missing");
const guideSource = fs.readFileSync(path.join(root, "lib/game-guide.ts"), "utf8");
if (!guideSource.includes("GAME_GUIDE_SECTIONS") || !guideSource.includes("telegramGameGuideText")) failures.push("Detailed game guide is missing");
const stateViewSource = fs.readFileSync(path.join(root, "components/game/state-view.tsx"), "utf8");
if (!stateViewSource.includes("GameGuidePanel") || !stateViewSource.includes("GAME_GUIDE_SECTIONS")) failures.push("Mini App game guide section is missing");
const gameAppSource = fs.readFileSync(path.join(root, "components/game-app.tsx"), "utf8");
for (const marker of ["contentSafeAreaInset", "--ws-telegram-top", "safeAreaChanged"]) {
  if (!gameAppSource.includes(marker)) failures.push(`Telegram safe-area integration is missing: ${marker}`);
}
if ((gameAppSource.match(/const \[lastSyncAt, setLastSyncAt\]/g) || []).length !== 1) failures.push("game-app.tsx contains a duplicated lastSyncAt state declaration");
const redesignCss = fs.readFileSync(path.join(root, "app/warstate-redesign.css"), "utf8");
if (!redesignCss.includes("--tg-content-safe-area-inset-top") || !redesignCss.includes("--ws-safe-top")) failures.push("Mini App CSS does not account for Telegram content safe area");
const governmentRouteSource = fs.readFileSync(path.join(root, "app/api/game/government/route.ts"), "utf8");
if (!governmentRouteSource.includes("assertTelegramChatOwner") || !governmentRouteSource.includes('action === "delete_state"')) failures.push("Owner-only state deletion route is incomplete");

const attackRouteSource = fs.readFileSync(path.join(root, "app/api/game/island/attack/route.ts"), "utf8");
if (!attackRouteSource.includes("createStateVote") || attackRouteSource.includes("startWarAction")) failures.push("Mini App attack route must start a civic vote instead of a direct battle");
const diplomacyRouteSource = fs.readFileSync(path.join(root, "app/api/game/diplomacy/route.ts"), "utf8");
if (!diplomacyRouteSource.includes("createStateVote") || !diplomacyRouteSource.includes('action === "propose_alliance" || action === "accept_alliance"')) failures.push("Mini App alliance creation/acceptance must be vote-gated");
const actionSource = fs.readFileSync(path.join(root, "lib/actions.ts"), "utf8");
if (!actionSource.includes('new Set(["president"])')) failures.push("War initiation core guard must be President-only");

const commandSource = fs.readFileSync(path.join(root, "lib/chat-commands.ts"), "utf8");
const requiredCommands = [
  "помощь","государство","статус","ресурсы","рейтинг","карта","альянсы","президент","замы","выборы","голосовать",
  "назначитьпрезидента","назначитьзама","снятьзама","казна","постройки","улучшить","налоги","война","бой","сдаться","разведка",
  "оборона","союз","разорватьсоюз","активность","миссия","награда","профиль","создатьюз","юз","название","найти",
  "роли","роль","голосование","шпион","соо","добыча","сдать","магазин","купить","использовать","титул","инвестировать","кража","договор","играть","как_играть","гайд","мойид","админ","диагностика","версия",
];
for (const command of requiredCommands) if (!commandSource.includes(`"${command}"`) && !commandSource.includes(`'${command}'`)) failures.push(`Requested chat command is missing: !${command}`);

const helpStart = commandSource.indexOf("const HELP_SECTIONS");
const helpEnd = commandSource.indexOf("function helpMenuKeyboard", helpStart);
const helpSource = helpStart >= 0 && helpEnd > helpStart ? commandSource.slice(helpStart, helpEnd) : "";
const requiredHelpCommands = [
  "вступить","государство","статус","карта","рейтинг","государства","найти","создатьюз","юз","название",
  "президент","замы","назначитьпрезидента","снятьпрезидента","назначитьзама","снятьзама","выборы","голосовать","голосование","импичмент",
  "ресурсы","казна","налоги","постройки","улучшить","роли","роль","министртруда","снятьминистра",
  "добыча","сдать","магазин","купить","использовать","титул","инвестировать","разведка","шпион","кража","договор",
  "война","бой","оборона","поддержать","сдаться","альянсы","союз","разорватьсоюз","соо","чп","часовойпояс",
  "профиль","вклад","активность","миссия","награда","играть","гайд","помощь","оботе","версия","мойид","админ","диагностика",
];
for (const command of requiredHelpCommands) if (!helpSource.includes(`!${command}`)) failures.push(`Interactive help does not document: !${command}`);


const commandSetBlock = commandSource.match(/const WARSTATE_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
const registeredCommandAliases = commandSetBlock ? [...commandSetBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
const handlerStart = commandSource.indexOf("export async function handleGroupTextCommand");
const handlerEnd = commandSource.indexOf("export async function handleGroupCallback");
const commandHandlerSource = handlerStart >= 0 && handlerEnd > handlerStart ? commandSource.slice(handlerStart, handlerEnd) : "";
for (const alias of registeredCommandAliases) {
  if (!commandHandlerSource.includes(`"${alias}"`)) failures.push(`Registered command alias has no handler route: !${alias}`);
}
if (!commandSource.includes('if (!WARSTATE_COMMANDS.has(command)) return null')) failures.push("Unknown !commands must be ignored instead of answered");
if (commandSource.includes("КОМАНДА НЕ НАЙДЕНА")) failures.push("Unknown !commands still produce a WARSTATE error reply");
for (const alias of ["мойид", "мойid", "myid", "админ", "admin", "диагностика", "проверка"]) {
  const occurrences = commandSource.split(`"${alias}"`).length - 1;
  if (occurrences < 2) failures.push(`Command alias is registered but not routed: !${alias}`);
}
const repairMigration = fs.readFileSync(path.join(root, "supabase/migrations/024_repair_government_commands.sql"), "utf8");
for (const fn of ["gw_appoint_president","gw_remove_president","gw_nominate_founder_for_president","gw_vote_for_player","gw_cast_vote","gw_finalize_election","gw_command_health"]) {
  if (!repairMigration.includes(fn)) failures.push(`Government repair migration is missing: ${fn}`);
}

const adminRewardMigration = fs.readFileSync(path.join(root, "supabase/migrations/035_admin_rewards_medals_access.sql"), "utf8");
for (const marker of ["player_medals", "state_medals", "admin_reward_log", "admin_chat_access_requests", "gw_admin_apply_reward", "gw_apply_admin_xp_boost", "admin_threat_shield_until"]) {
  if (!adminRewardMigration.includes(marker)) failures.push(`Admin reward migration is missing: ${marker}`);
}
const adminRewardsSource = fs.readFileSync(path.join(root, "lib/admin-rewards.ts"), "utf8");
for (const marker of ["grantAdminReward", "requestAdminGroupAccess", "handleAdminAccessReply", "sendAdminStateMessage"]) {
  if (!adminRewardsSource.includes(marker)) failures.push(`Admin rewards core is missing: ${marker}`);
}
if (!webhookSource.includes("handleAdminAccessReply")) failures.push("Telegram webhook does not handle private-group admin invite replies");
const requestAuthSource = fs.readFileSync(path.join(root, "lib/request-auth.ts"), "utf8");
if (!requestAuthSource.includes("requireTelegramBotUsername")) failures.push("Mini App is not gated by TELEGRAM_BOT_USERNAME");
if (!webhookSource.includes("requireTelegramBotUsername")) failures.push("Telegram webhook is not gated by TELEGRAM_BOT_USERNAME");
const stateMessagesSource = fs.readFileSync(path.join(root, "lib/state-messages.ts"), "utf8");
for (const marker of ["sendInterstateMessage", "handleInterstateReply", "target_message_id", "Reply"]) {
  if (!stateMessagesSource.includes(marker)) failures.push(`Interstate messaging core is missing: ${marker}`);
}
if (!webhookSource.includes("handleInterstateReply")) failures.push("Telegram webhook does not route interstate Reply messages");
const economyMigration = fs.readFileSync(path.join(root, "supabase/migrations/040_personal_economy_v54.sql"), "utf8");
for (const marker of ["gw_personal_economy_snapshot","gw_personal_gather","gw_sell_personal_resource","gw_buy_personal_item","gw_buy_noble_title","gw_invest_glory","gw_wild_raid","gw_enforce_state_resource_floor","economy_sleeping"]) {
  if (!economyMigration.includes(marker)) failures.push(`Personal economy migration is missing: ${marker}`);
}
for (const marker of ["🏰 Замок","💼 Роли","💰 Экономика","⚔️ Военные действия","👤 Профиль","━━━━━━"]) {
  if (!commandSource.includes(marker)) failures.push(`Interactive help is missing: ${marker}`);
}
if (!commandSource.includes('snapshot.player.dutyRole !== "spy"')) failures.push("Spy role is not allowed to use reconnaissance");

const releaseAuditMigration = fs.readFileSync(path.join(root, "supabase/migrations/041_release_candidate_audit.sql"), "utf8");
for (const marker of ["request_message_id = 0", "<= 50", "Инструмент II ещё активен", "более высокий дворянский титул"]) {
  if (!releaseAuditMigration.includes(marker)) failures.push(`Release-audit migration is missing: ${marker}`);
}
if (/createSingleUseInviteLink|getOrCreateAutoInvite|AUTO_INVITE_MESSAGE_ID/.test(adminRewardsSource)) failures.push("Private admin group access regressed to bot-minted invite links");
const cooldownSource = fs.readFileSync(path.join(root, "lib/cooldown.ts"), "utf8");
if (cooldownSource.includes("allowing through") || /if\s*\(error\)[\s\S]{0,160}return true/.test(cooldownSource)) failures.push("Command cooldown still fails open on database errors");
const mapSource = fs.readFileSync(path.join(root, "components/game/island-map.tsx"), "utf8");
if (!mapSource.includes("if (!cache) {") || !mapSource.includes("drawWorldTerrain(ctx,cam,width,height)")) failures.push("Canvas terrain cache null fallback is missing");
const dynamicEventsSource = fs.readFileSync(path.join(root, "lib/dynamic-events.ts"), "utf8");
if (!dynamicEventsSource.includes("threat loss rollback") || !dynamicEventsSource.includes("anarchy loss rollback")) failures.push("Dynamic-event loss RPC rollback protection is missing");
if (envExample.includes("08/11/14/17/20")) failures.push(".env.example documents the obsolete emergency schedule");

const releasePolishMigration = fs.readFileSync(path.join(root, "supabase/migrations/042_release_polish.sql"), "utf8");
for (const marker of ["gw_admin_payment_totals", "starsLast7d", "gw_claim_telegram_update_v2", "gw_complete_telegram_update", "completed_at", "service_role"]) {
  if (!releasePolishMigration.includes(marker)) failures.push(`Release-polish migration is missing: ${marker}`);
}
const adminSource = fs.readFileSync(path.join(root, "lib/admin.ts"), "utf8");
if (!adminSource.includes('rpc("gw_admin_payment_totals")')) failures.push("Admin Stars totals are not using the server-side aggregate RPC");
if (adminSource.includes('.limit(2000)') && adminSource.includes('stars,created_at')) failures.push("Admin Stars totals regressed to a capped client-side sum");
if (!adminSource.includes("const batchSize = 18")) failures.push("Admin broadcast bounded batching is missing");
const configSource = fs.readFileSync(path.join(root, "lib/config.ts"), "utf8");
if (!configSource.includes('endsWith("bot")') || !configSource.includes('[A-Za-z0-9_]{5,32}')) failures.push("Telegram bot username validation is incomplete");
const redesignSource = fs.readFileSync(path.join(root, "app/warstate-redesign.css"), "utf8");
if (!redesignSource.includes("WARSTATE v5.4.2 release UI normalization")) failures.push("v5.4.2 UI normalization layer is missing");
if (!redesignSource.includes("--ws-safe-left") || !redesignSource.includes("--ws-safe-right")) failures.push("Horizontal Telegram safe-area handling is missing");
if (!gameAppSource.includes("requestFullscreen") || !gameAppSource.includes("app?.ready?.()") || !gameAppSource.includes("app?.expand?.()")) failures.push("Shared Telegram WebApp bootstrap/fullscreen initialization is missing");
const adminPanelSource = fs.readFileSync(path.join(root, "components/game/admin-panel.tsx"), "utf8");
if (adminPanelSource.includes("app?.ready?.()") || adminPanelSource.includes("app?.expand?.()")) failures.push("Admin panel duplicates Telegram chrome bootstrap instead of using the shared app initialization");
if (!mapSource.includes("zoomRatio >= .82") || !mapSource.includes("cache.anchor.zoom / cam.zoom")) failures.push("Buffered terrain zoom reuse is missing; terrain may rebuild on every zoom frame");
if (!mapSource.includes("Math.max(20,textW-16)")) failures.push("Map state labels do not clamp long text to their card width");
const strategyPanelSource = fs.readFileSync(path.join(root, "components/game/strategy-panel.tsx"), "utf8");
if (!strategyPanelSource.includes('"через !сдать"') || strategyPanelSource.includes("productionTotal")) failures.push("Strategy economy UI still describes raw resources as passive hourly production");
const wildRaidStart = commandSource.indexOf('if (command === "кража"');
const wildRaidBlock = wildRaidStart >= 0 ? commandSource.slice(wildRaidStart, wildRaidStart + 520) : "";
if (wildRaidBlock.includes('dutyRole !== "spy" && !superAdminMode')) failures.push("Wild raid role gate disagrees with the database invariant");
if (!commandSource.includes('const canDiplomacy = superAdminMode || snapshot.player.role === "president" || snapshot.player.dutyRole === "diplomat"')) failures.push("Project-admin diplomacy bypass is not scoped to explicit chat super-admin mode");

const interstateMigration = fs.readFileSync(path.join(root, "supabase/migrations/039_interstate_messages.sql"), "utf8");
for (const marker of ["state_messages", "target_message_id", "uq_state_messages_target_telegram_message"]) {
  if (!interstateMigration.includes(marker)) failures.push(`Interstate messaging migration is missing: ${marker}`);
}

// Every SECURITY DEFINER function must have an explicit client revoke somewhere
// in migrations. Supabase/PostgREST can otherwise expose internal trigger helpers
// as RPC endpoints even when application code never calls them directly.
const allMigrationSql = migrationFiles.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const securityDefinerFunctions = [...allMigrationSql.matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\([^)]*\)[\s\S]*?security\s+definer/gi)]
  .map((match) => match[1]);
for (const functionName of new Set(securityDefinerFunctions)) {
  const revokePattern = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+(?:public\\.)?${functionName}\\s*\\(`, "i");
  if (!revokePattern.test(allMigrationSql)) failures.push(`SECURITY DEFINER function lacks explicit client revoke: ${functionName}`);
}
const finalHardeningMigration = fs.readFileSync(path.join(root, "supabase/migrations/043_release_final_hardening.sql"), "utf8");
for (const marker of ["gw_prepare_battle_strategy", "gw_apply_admin_xp_boost", "gw_enforce_state_resource_floor"]) {
  if (!finalHardeningMigration.includes(marker)) failures.push(`Final hardening migration is missing revoke: ${marker}`);
}

// API trust-boundary audit. Game mutations must enter through Telegram
// initData authorization, admin routes require project-admin identity, cron
// endpoints require their shared secret, and the Telegram webhook must validate
// Telegram's secret-token header. The avatar proxy is the only intentionally
// public route and is constrained to a state-owned Telegram file id.
const apiRoutesForSecurity = walk("app/api").filter((file) => file.endsWith("route.ts"));
for (const route of apiRoutesForSecurity) {
  const source = fs.readFileSync(path.join(root, route), "utf8");
  if (route.startsWith("app/api/admin/")) {
    if (!source.includes("sessionFromRequest") || !source.includes("isProjectAdminTelegramId")) failures.push(`Admin API route lacks Telegram admin authorization: ${route}`);
  } else if (route.startsWith("app/api/game/")) {
    if (!["sessionFromRequest", "authorizeStateAction", "authorizeBattleAction"].some((marker) => source.includes(marker))) failures.push(`Game API route lacks Telegram authorization: ${route}`);
  } else if (route.startsWith("app/api/cron/")) {
    if (!source.includes("CRON_SECRET")) failures.push(`Cron API route lacks CRON_SECRET authorization: ${route}`);
  } else if (route === "app/api/telegram/invoice/route.ts") {
    if (!["sessionFromRequest", "authorizeStateAction"].some((marker) => source.includes(marker))) failures.push("Telegram invoice route lacks initData authorization");
  } else if (route === "app/api/telegram/webhook/route.ts") {
    if (!source.includes("x-telegram-bot-api-secret-token") || !source.includes("TELEGRAM_WEBHOOK_SECRET")) failures.push("Telegram webhook secret-token validation is missing");
  } else if (route === "app/api/telegram/chat-photo/route.ts") {
    if (!source.includes('select("chat_avatar_file_id")') || !source.includes("telegramFileUrl")) failures.push("Public chat-photo proxy is not constrained to state avatar file ids");
  }
}

const routes = walk("app/api").filter((file) => file.endsWith("route.ts"));
notes.push(`${sourceFiles.length} source files scanned`);
notes.push(`${routes.length} API routes found`);
notes.push(`${referencedEnv.size} environment variables referenced and documented`);
notes.push(`${referencedRpc.size}/${referencedRpc.size} referenced RPCs found in migrations`);
notes.push(`${requiredCommands.length}/${requiredCommands.length} required chat commands present`);
notes.push(`${registeredCommandAliases.length}/${registeredCommandAliases.length} registered command aliases routed`);
notes.push("Vercel Cron dependency: disabled by default (event-driven runtime)");
notes.push("WARSTATE v5.4.2 release audit + normalized UI + closed economy: present");
if (!fs.readFileSync(path.join(root, "README.md"), "utf8").includes("/setprivacy")) failures.push("README must document disabling BotFather Privacy Mode for !commands");
notes.push("Telegram webhook idempotency: PostgreSQL-backed");
notes.push("Baseline security headers: enabled");

if (failures.length) {
  console.error("WARSTATE project audit: FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("WARSTATE project audit: OK");
for (const note of notes) console.log(`- ${note}`);
