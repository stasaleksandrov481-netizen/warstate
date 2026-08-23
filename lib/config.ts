export function env(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

export const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

export function requireServerEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
