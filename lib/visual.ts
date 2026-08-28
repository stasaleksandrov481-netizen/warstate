export function stateMarkText(name?: string | null, emblem?: string | null) {
  const rawEmblem = String(emblem || "").trim();
  const cleaned = rawEmblem
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();

  if (cleaned && cleaned.length <= 3) return cleaned.toLocaleUpperCase("ru-RU");

  const words = String(name || "")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);

  if (words.length >= 2) return `${words[0][0] || ""}${words[1][0] || ""}`.toLocaleUpperCase("ru-RU");
  if (words[0]) return words[0].slice(0, Math.min(2, words[0].length)).toLocaleUpperCase("ru-RU");
  return "WS";
}
