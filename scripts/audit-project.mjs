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
if (!String(packageJson.version || "").startsWith("1.7.")) failures.push(`Expected v1.7.x package version, found ${packageJson.version}`);

const routes = walk("app/api").filter((file) => file.endsWith("route.ts"));
notes.push(`${sourceFiles.length} source files scanned`);
notes.push(`${routes.length} API routes found`);
notes.push(`${referencedEnv.size} environment variables referenced and documented`);

if (failures.length) {
  console.error("WARSTATE project audit: FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("WARSTATE project audit: OK");
for (const note of notes) console.log(`- ${note}`);
