export function requireData<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

export function safeInteger(value: unknown, defaultValue = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

export function safeNumber(value: unknown, defaultValue = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}
