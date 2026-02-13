import { load } from "@std/dotenv";
import { log } from "./src/logger.ts";
import { initStorage } from "./src/storage.ts";
import { initRateLimits } from "./src/groq/ratelimits.ts";
import { initRenderer } from "./src/image/renderer.ts";
import { createBot } from "./src/bot.ts";
import { getPersonaConfigs } from "./src/groq/personas.ts";

try {
  await load({ export: true });
} catch {
  // .env not present — env vars injected by platform
}

const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const groqApiKey = Deno.env.get("GROQ_API_KEY");

if (!telegramToken || !groqApiKey) {
  log.error("system", "Missing TELEGRAM_BOT_TOKEN or GROQ_API_KEY in .env");
  Deno.exit(1);
}

await initStorage();
await initRateLimits();
initRenderer();

const bot = createBot(telegramToken, groqApiKey);

const coreConfigs = getPersonaConfigs("en");
log.info("system", "MAGI System online. Three cores initialized.");
for (const key of ["melchior", "balthasar", "casper"] as const) {
  log.info("system", `  ${coreConfigs[key].name.padEnd(16)}... OK`);
}
log.info("system", "Awaiting queries...");

// Health check endpoint
const port = parseInt(Deno.env.get("PORT") || "8000");
const server = Deno.serve({ port }, () => new Response("MAGI SYSTEM ONLINE"));

// Graceful shutdown — stop polling and HTTP server before container dies
const shutdown = () => {
  log.info("system", "MAGI System shutting down...");
  bot.stop();
  server.shutdown();
};
Deno.addSignalListener("SIGTERM", shutdown);
Deno.addSignalListener("SIGINT", shutdown);

// Start polling with retry — handles 409 conflict during rolling deployments
const MAX_RETRIES = 5;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    await bot.start({ drop_pending_updates: true });
    break;
  } catch (err) {
    const is409 = err instanceof Error && err.message.includes("409");
    if (is409 && attempt < MAX_RETRIES - 1) {
      const delay = (attempt + 1) * 3;
      log.warn("system", "Conflict: previous instance still polling", {
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        delaySec: delay,
      });
      await new Promise((r) => setTimeout(r, delay * 1000));
      continue;
    }
    throw err;
  }
}
