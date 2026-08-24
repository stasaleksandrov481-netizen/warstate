import { randomUUID } from "node:crypto";

type RedisResult<T = unknown> = { result?: T; error?: string };
type LocalRate = { count: number; resetAt: number };

const localRates = new Map<string, LocalRate>();
const localLocks = new Map<string, { token: string; expiresAt: number }>();

function config() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
  return url && token ? { url, token } : null;
}

export function redisConfigured() {
  return Boolean(config());
}

async function command<T = unknown>(args: Array<string | number>): Promise<T | null> {
  const cfg = config();
  if (!cfg) throw new Error("Redis is not configured.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Redis unavailable (${response.status}).`);
    const payload = (await response.json()) as RedisResult<T>;
    if (payload.error) throw new Error(`Redis error: ${payload.error}`);
    return payload.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function localRateLimit(key: string, limit: number, windowSeconds: number) {
  const now = Date.now();
  const namespaced = `gw:rate:${key}`;
  const current = localRates.get(namespaced);
  const row = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + Math.max(1, windowSeconds) * 1000 }
    : { ...current, count: current.count + 1 };
  localRates.set(namespaced, row);
  if (row.count > limit) throw new Error("Слишком много действий подряд. Попробуйте чуть позже.");
  if (localRates.size > 1500) {
    for (const [entry, value] of localRates) if (value.resetAt <= now) localRates.delete(entry);
  }
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  if (!redisConfigured()) {
    localRateLimit(key, limit, windowSeconds);
    return;
  }
  try {
    const count = Number(await command<number>(["INCR", `gw:rate:${key}`]) || 0);
    if (count === 1) await command(["EXPIRE", `gw:rate:${key}`, Math.max(1, windowSeconds)]);
    if (count > limit) throw new Error("Слишком много действий подряд. Попробуйте чуть позже.");
  } catch (error) {
    // Availability first: SQL remains authoritative for balances, battles and
    // idempotency. A short Redis outage should not disable the game entirely.
    if (error instanceof Error && error.message.startsWith("Слишком много")) throw error;
    localRateLimit(key, limit, windowSeconds);
  }
}

async function acquireLocalLock(key: string, ttlSeconds: number) {
  const now = Date.now();
  const namespaced = `gw:lock:${key}`;
  const existing = localLocks.get(namespaced);
  if (existing && existing.expiresAt > now) throw new Error("Это действие уже выполняется. Повторите через несколько секунд.");
  const token = randomUUID();
  localLocks.set(namespaced, { token, expiresAt: now + Math.max(1, ttlSeconds) * 1000 });
  return token;
}

async function acquireLock(key: string, ttlSeconds: number) {
  if (!redisConfigured()) return acquireLocalLock(key, ttlSeconds);
  const token = randomUUID();
  try {
    const result = await command<string>(["SET", `gw:lock:${key}`, token, "NX", "EX", Math.max(1, ttlSeconds)]);
    if (result !== "OK") throw new Error("Это действие уже выполняется. Повторите через несколько секунд.");
    return token;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Это действие уже")) throw error;
    return acquireLocalLock(key, ttlSeconds);
  }
}

async function releaseLock(key: string, token: string | null) {
  if (!token) return;
  const namespaced = `gw:lock:${key}`;
  const local = localLocks.get(namespaced);
  if (local?.token === token) localLocks.delete(namespaced);
  if (!redisConfigured()) return;
  await command([
    "EVAL",
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    1,
    namespaced,
    token,
  ]).catch(() => undefined);
}

export async function withActionLock<T>(key: string, ttlSeconds: number, task: () => Promise<T>): Promise<T> {
  const token = await acquireLock(key, ttlSeconds);
  try {
    return await task();
  } finally {
    await releaseLock(key, token);
  }
}
