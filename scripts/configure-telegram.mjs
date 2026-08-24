const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !appUrl || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN, NEXT_PUBLIC_APP_URL and TELEGRAM_WEBHOOK_SECRET first.");
  process.exit(1);
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  console.log(method, "OK");
  return json.result;
}

await api("setWebhook", {
  url: `${appUrl.replace(/\/$/, "")}/api/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ["message", "my_chat_member", "callback_query", "pre_checkout_query"],
});

await api("setMyCommands", {
  commands: [
    { command: "groupwars", description: "Открыть WARSTATE для этого чата" },
    { command: "gw", description: "Быстрый вход в игру" },
  ],
});

console.log("Telegram bot configured.");
