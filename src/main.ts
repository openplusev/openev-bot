import { ErrorBoundary } from "@/bot/guards/error-boundary.guard";
import { guildTargets, runAlertsFeed } from "@/core/services/alerts.feed";
import { startDmAlerts } from "@/core/services/dm-alerts";
import { runDryRun } from "@/core/services/dry-run";
import { loadGuildSettings } from "@/core/services/guild-settings";
import { logger } from "@/lib/logger";
import {
  INTERNAL_TOKEN,
  fetchSubscribers,
  recordDelivery,
} from "@/lib/openev/internal";
import { OPENEV_WEBSITE_URL } from "@/shared/config/openev";
import { ActivityType, GatewayIntentBits } from "discord.js";
import { Client } from "discordx";
import "./bot";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const devGuildId = process.env.DEV_GUILD_ID?.trim();
const dryRun = process.env.DRY_RUN?.trim() === "1";

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
  await loadGuildSettings();
  if (INTERNAL_TOKEN) {
    await startDmAlerts({
      fetchSubscribers,
      recordDelivery,
      send: async (discordId, message) => {
        await bot.users.send(discordId, {
          embeds: message.embeds,
          components: message.components,
          allowedMentions: { parse: [] },
        });
      },
      onDecision: (d) =>
        d.decision === "skip" || d.decision === "queued"
          ? logger.debug("DM decision", { ...d })
          : logger.info("DM decision", { ...d }),
    });
  } else {
    logger.warn("INTERNAL_TOKEN is not set, personal DM alerts are off");
  }
  await runAlertsFeed({ persist: true, targets: () => guildTargets(bot) });
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
    await runDryRun(Number(process.env.DRY_RUN_SAMPLES) || 3);
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
        name: process.env.BOT_ACTIVITY?.trim() || OPENEV_WEBSITE_URL,
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
