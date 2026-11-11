import { ErrorBoundary } from "@/bot/guards/error-boundary.guard";
import { runAlertsDryRun, startAlertsFeed } from "@/core/services/alerts.feed";
import { startResultsFeed } from "@/core/services/results.feed";
import { logger } from "@/lib/logger";
import { WEBSITE_URL } from "@/shared/config/branding";
import { ActivityType, GatewayIntentBits } from "discord.js";
import { Client } from "discordx";
import "./bot";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const devGuildId = process.env.DEV_GUILD_ID?.trim();
const dryRun = process.env.DRY_RUN?.trim() === "1";

if (!dryRun && !process.env.BOT_API_TOKEN?.trim()) {
  logger.warn("BOT_API_TOKEN is not set, API calls will be rejected");
}

export const bot = new Client({
  intents: [GatewayIntentBits.Guilds],
  silent: true,
  ...(devGuildId ? { botGuilds: [devGuildId] } : {}),
  guards: [ErrorBoundary],
});

bot.once("clientReady", async () => {
  await bot.initApplicationCommands();
  logger.info("Bot started", {
    clientId: bot.user?.id,
    guilds: bot.guilds.cache.size,
    commandScope: devGuildId ? `guild ${devGuildId}` : "global",
  });
  await startResultsFeed(bot);
  await startAlertsFeed(bot);
});

bot.on("interactionCreate", (interaction) => {
  void bot.executeInteraction(interaction);
});

// Log and keep running: the ErrorBoundary covers handlers, these cover timers and gateway.
process.on("unhandledRejection", (reason) =>
  logger.error("Unhandled rejection", { error: String(reason) }),
);
process.on("uncaughtException", (err) =>
  logger.error("Uncaught exception", { error: String(err) }),
);
bot.on("error", (err) => logger.error("Client error", { error: String(err) }));
bot.on("shardError", (err) =>
  logger.error("Shard error", { error: String(err) }),
);

async function main() {
  if (dryRun) {
    await runAlertsDryRun(Number(process.env.DRY_RUN_SAMPLES) || 3);
    return;
  }
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set");
    process.exit(1);
  }
  await bot.login(token);
  bot.user?.setPresence({
    activities: [
      {
        name: process.env.BOT_ACTIVITY?.trim() || WEBSITE_URL,
        type: ActivityType.Watching,
      },
    ],
  });
}

main().catch((err) => {
  logger.error(dryRun ? "Dry run failed" : "Login failed", {
    error: String(err),
  });
  process.exit(1);
});
