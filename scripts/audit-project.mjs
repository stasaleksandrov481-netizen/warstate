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

const commandSource = fs.readFileSync(path.join(root, "lib/chat-commands.ts"), "utf8");
const requiredCommands = [
  "помощь","государство","статус","ресурсы","рейтинг","карта","альянсы","президент","замы","выборы","голосовать",
  "назначитьпрезидента","назначитьзама","снятьзама","казна","постройки","улучшить","налоги","война","бой","сдаться","разведка",
  "оборона","союз","разорватьсоюз","активность","миссия","награда","профиль","создатьюз","юз","название","найти",
];
for (const command of requiredCommands) if (!commandSource.includes(`"${command}"`) && !commandSource.includes(`'${command}'`)) failures.push(`Requested chat command is missing: !${command}`);

const routes = walk("app/api").filter((file) => file.endsWith("route.ts"));
notes.push(`${sourceFiles.length} source files scanned`);
notes.push(`${routes.length} API routes found`);
notes.push(`${referencedEnv.size} environment variables referenced and documented`);
notes.push(`${referencedRpc.size}/${referencedRpc.size} referenced RPCs found in migrations`);
notes.push(`${requiredCommands.length}/${requiredCommands.length} required chat commands present`);
notes.push("Vercel Cron dependency: disabled by default (event-driven runtime)");
notes.push("Telegram webhook idempotency: PostgreSQL-backed");
notes.push("Baseline security headers: enabled");

if (failures.length) {
  console.error("WARSTATE project audit: FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("WARSTATE project audit: OK");
for (const note of notes) console.log(`- ${note}`);
