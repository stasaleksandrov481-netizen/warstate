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
if (!String(packageJson.version || "").startsWith("2.0.")) failures.push(`Expected v2.0.x package version, found ${packageJson.version}`);

const requiredV20 = [
  "supabase/migrations/015_event_driven_runtime.sql",
  "supabase/migrations/016_member_activity_votes_spy.sql",
  "supabase/migrations/017_telegram_update_claim_lease.sql",
  "supabase/migrations/018_state_switch_delete_ui.sql",
  "supabase/migrations/023_founder_president_admin.sql",
  "supabase/migrations/024_repair_government_commands.sql",
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
if (!webhookSource.includes("gw_claim_telegram_update")) failures.push("Telegram webhook idempotency claim is missing");
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
    rpcDefinitions.set(match[1], { params, optional, file });
  }
}
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const calls = [
    ...text.matchAll(/\.rpc\(\s*["']([a-zA-Z0-9_]+)["']\s*,\s*\{([\s\S]*?)\}\s*\)/g),
  ];
  for (const call of calls) {
    const definition = rpcDefinitions.get(call[1]);
    if (!definition) continue;
    const keys = [...call[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)].map((m) => m[1]);
    const unknown = keys.filter((key) => !definition.params.includes(key));
    const missing = definition.params.filter((name) => !keys.includes(name) && !definition.optional.has(name));
    if (unknown.length || missing.length) failures.push(`RPC argument mismatch: ${file} -> ${call[1]} (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"}; latest: ${definition.file})`);
  }
}

const communityMigration = fs.readFileSync(path.join(root, "supabase/migrations/016_member_activity_votes_spy.sql"), "utf8");
for (const marker of ["duty_role", "state_votes", "state_vote_ballots", "spy_quests", "gw_resolve_spy_quest", "chat_message_progress"]) {
  if (!communityMigration.includes(marker)) failures.push(`Migration 016 is missing community mechanic: ${marker}`);
}
if (!webhookSource.includes('["group", "supergroup"].includes(message.chat.type)')) failures.push("Telegram webhook must handle both group and supergroup chats");
if (/РЕСУРСЫ ЗА АКТИВНОСТЬ|Чат нафармил|10 сообщений граждан/.test(webhookSource)) failures.push("Chat activity resource notification must stay silent");
if (!webhookSource.includes("handleGroupTextCommand(message)")) failures.push("Telegram group command handler is not wired into webhook");
const gameSource = fs.readFileSync(path.join(root, "lib/game.ts"), "utf8");
const communitySource = fs.readFileSync(path.join(root, "lib/community.ts"), "utf8");
if (!gameSource.includes("getPlayerMemberSnapshot") || !gameSource.includes("isMissingDutyRoleError")) failures.push("Mini App bootstrap lacks duty-role migration compatibility");
if (!communitySource.includes("if (error && isMissingDutyRoleError(error)) return rates")) failures.push("Workforce production must tolerate a rolling duty_role migration");
const islandSource = fs.readFileSync(path.join(root, "lib/islands.ts"), "utf8");
if (!islandSource.includes('.eq("is_beginner_island", true)')) failures.push("Beginner island is not force-included in world map data");
if (!islandSource.includes("direct state query is a safe read-only fallback") || !islandSource.includes('String(row.id) === String(stateId)')) failures.push("Island world lacks RPC fallback or own-island injection");
const telegramBotSource = fs.readFileSync(path.join(root, "lib/telegram-bot.ts"), "utf8");
if (!telegramBotSource.includes('getChatMember') || !telegramBotSource.includes('createStateJoinLink')) failures.push("Telegram membership gate or invite-link fallback is missing");
if (!telegramBotSource.includes('assertTelegramChatOwner')) failures.push("Telegram owner gate for state deletion is missing");
const stateSwitchSource = fs.readFileSync(path.join(root, "app/api/game/state/switch/route.ts"), "utf8");
if (!stateSwitchSource.includes("assertTelegramChatMembership") || !stateSwitchSource.includes("gw_switch_player_state")) failures.push("Explicit state switch membership gate is incomplete");
const themeSource = fs.readFileSync(path.join(root, "app/game-theme.css"), "utf8");
if (/\.game-world-layer\{[^}]*contain\s*:\s*layout style paint/i.test(themeSource)) failures.push("World layer still clips island nodes with paint containment");
const guideSource = fs.readFileSync(path.join(root, "lib/game-guide.ts"), "utf8");
if (!guideSource.includes("GAME_GUIDE_SECTIONS") || !guideSource.includes("telegramGameGuideText")) failures.push("Detailed game guide is missing");
const stateViewSource = fs.readFileSync(path.join(root, "components/game/state-view.tsx"), "utf8");
if (!stateViewSource.includes("GameGuidePanel") || !stateViewSource.includes("GAME_GUIDE_SECTIONS")) failures.push("Mini App game guide section is missing");
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
  "роли","роль","голосование","шпион","играть","как_играть","гайд","мойид","админ","диагностика",
];
for (const command of requiredCommands) if (!commandSource.includes(`"${command}"`) && !commandSource.includes(`'${command}'`)) failures.push(`Requested chat command is missing: !${command}`);


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

const routes = walk("app/api").filter((file) => file.endsWith("route.ts"));
notes.push(`${sourceFiles.length} source files scanned`);
notes.push(`${routes.length} API routes found`);
notes.push(`${referencedEnv.size} environment variables referenced and documented`);
notes.push(`${referencedRpc.size}/${referencedRpc.size} referenced RPCs found in migrations`);
notes.push(`${requiredCommands.length}/${requiredCommands.length} required chat commands present`);
notes.push(`${registeredCommandAliases.length}/${registeredCommandAliases.length} registered command aliases routed`);
notes.push("Vercel Cron dependency: disabled by default (event-driven runtime)");
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
