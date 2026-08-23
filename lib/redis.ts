import { randomUUID } from "node:crypto";

type RedisResult<T = unknown> = { result?: T; error?: string };

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
  if (!cfg) throw new Error("Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Redis unavailable (${response.status}).`);
  const payload = (await response.json()) as RedisResult<T>;
  if (payload.error) throw new Error(`Redis error: ${payload.error}`);
  return payload.result ?? null;
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const count = Number(await command<number>(["INCR", `gw:rate:${key}`]) || 0);
  if (count === 1) await command(["EXPIRE", `gw:rate:${key}`, Math.max(1, windowSeconds)]);
  if (count > limit) throw new Error("Слишком много действий подряд. Попробуйте чуть позже.");
}

async function acquireLock(key: string, ttlSeconds: number) {
  const token = randomUUID();
  const result = await command<string>(["SET", `gw:lock:${key}`, token, "NX", "EX", Math.max(1, ttlSeconds)]);
  if (result !== "OK") throw new Error("Это действие уже выполняется. Повторите через несколько секунд.");
  return token;
}

async function releaseLock(key: string, token: string | null) {
  if (!token) return;
  await command([
    "EVAL",
    "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
    1,
    `gw:lock:${key}`,
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
