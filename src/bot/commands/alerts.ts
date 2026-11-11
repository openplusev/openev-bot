import { alertSettingsEmbed } from "@/core/embeds/alert-settings.embed";
import { previewAlert } from "@/core/services/alerts.feed";
import {
  guildSettings,
  updateGuildSettings,
} from "@/core/services/guild-settings";
import { FEED_CHANNEL_TYPES, feedChannel } from "@/core/utils/channel.utils";
import {
  replyEphemeral,
  safeDeferReply,
  safeEditReply,
} from "@/core/utils/command.utils";
import { percent } from "@/core/utils/openev.utils";
import { logger } from "@/lib/logger";
import { fetchBookCodes } from "@/lib/openev/client";
import {
  ALERT_CONFIDENCES,
  LEDGER_MIN_EV,
  bookName,
  isAlertConfidence,
} from "@/shared/config/openev";
import {
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  CommandInteraction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { Discord, Slash, SlashChoice, SlashGroup, SlashOption } from "discordx";

const BOOKS_TTL_MS = 5 * 60 * 1000;
// Leaves room inside Discord's 3 second autocomplete window.
const AUTOCOMPLETE_TIMEOUT_MS = 2_000;

let bookCache: { codes: string[]; at: number } | null = null;

// A failed refresh serves the stale list.
async function bookCodes(timeoutMs?: number): Promise<string[] | null> {
  if (bookCache && Date.now() - bookCache.at < BOOKS_TTL_MS) {
    return bookCache.codes;
  }
  try {
    bookCache = { codes: await fetchBookCodes(timeoutMs), at: Date.now() };
  } catch (err) {
    logger.warn("Loading books failed", { error: String(err) });
  }
  return bookCache?.codes ?? null;
}

function splitBooks(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
}

// Completes the last comma separated code and keeps the ones before it.
async function autocompleteBooks(interaction: AutocompleteInteraction) {
  const input = interaction.options.getFocused();
  const parts = input.split(",");
  const query = (parts.pop() ?? "").trim().toLowerCase();
  const chosen = splitBooks(parts.join(","));
  const prefix = chosen.length ? `${chosen.join(",")},` : "";
  const codes = (await bookCodes(AUTOCOMPLETE_TIMEOUT_MS)) ?? [];
  const choices = codes
    .filter((c) => !chosen.includes(c))
    .filter(
      (c) => c.includes(query) || bookName(c).toLowerCase().includes(query),
    )
    .map((c) => ({
      name: `${prefix}${bookName(c)} (${c})`.slice(0, 100),
      value: `${prefix}${c}`.slice(0, 100),
    }))
    .slice(0, 24);
  await interaction
    .respond([{ name: "All books", value: "all" }, ...choices].slice(0, 25))
    .catch(() => {});
}

@Discord()
@SlashGroup({
  name: "alerts",
  description: "Value bet and arb alerts in this server",
  contexts: [InteractionContextType.Guild],
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
})
@SlashGroup("alerts")
export class AlertsCommand {
  @Slash({ name: "channel", description: "Post value bet alerts here" })
  async channel(
    @SlashOption({
      name: "channel",
      description: "Text or announcement channel",
      required: true,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: FEED_CHANNEL_TYPES,
    })
    channel: { id: string },
    interaction: CommandInteraction,
  ) {
    const guild = interaction.guild;
    if (!guild) return;
    if (!feedChannel(guild, channel.id)) {
      await replyEphemeral(
        interaction,
        `I cannot post in <#${channel.id}>. Give me View Channel, Send Messages and Embed Links there.`,
      );
      return;
    }
    await updateGuildSettings(guild.id, { channelId: channel.id });
    await replyEphemeral(
      interaction,
      `New alerts will post in <#${channel.id}> from now on. Try \`/alerts test\` for a preview.`,
    );
  }

  @Slash({ name: "stop", description: "Stop posting alerts and arbs" })
  async stop(interaction: CommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    await updateGuildSettings(guildId, { channelId: null });
    await replyEphemeral(
      interaction,
      "Alerts are off. Your filters are kept for when you turn them back on.",
    );
  }

  @Slash({ name: "min_ev", description: "Only post alerts from this EV" })
  async minEv(
    @SlashOption({
      name: "percent",
      description: `Minimum EV in percent (the ledger starts at ${LEDGER_MIN_EV * 100})`,
      required: true,
      type: ApplicationCommandOptionType.Number,
      minValue: LEDGER_MIN_EV * 100,
      maxValue: 50,
    })
    value: number,
    interaction: CommandInteraction,
  ) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const s = await updateGuildSettings(guildId, { minEv: value / 100 });
    await replyEphemeral(
      interaction,
      `Alerts now need at least ${percent(s.minEv)} EV.`,
    );
  }

  @Slash({ name: "books", description: "Only post alerts from these books" })
  async books(
    @SlashOption({
      name: "books",
      description: "Book codes separated by commas, or all",
      required: true,
      type: ApplicationCommandOptionType.String,
      maxLength: 500,
      autocomplete: autocompleteBooks,
    })
    input: string,
    interaction: CommandInteraction,
  ) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    const wanted = splitBooks(input);
    if (wanted.length === 0 || wanted.includes("all")) {
      await updateGuildSettings(guildId, { books: [] });
      await replyEphemeral(interaction, "Alerts now cover every book.");
      return;
    }
    if (
      !(await safeDeferReply(interaction, { flags: [MessageFlags.Ephemeral] }))
    )
      return;
    const known = await bookCodes();
    if (!known) {
      await safeEditReply(
        interaction,
        "The book list is unavailable right now. Try again in a moment.",
      );
      return;
    }
    const unknown = wanted.filter((b) => !known.includes(b));
    if (unknown.length) {
      await safeEditReply(
        interaction,
        `Unknown book codes: ${unknown.join(", ")}. Pick them from the suggestions.`,
      );
      return;
    }
    const books = [...new Set(wanted)];
    await updateGuildSettings(guildId, { books });
    await safeEditReply(
      interaction,
      `Alerts now cover ${books.map(bookName).join(", ")}.`,
    );
  }

  @Slash({
    name: "confidence",
    description: "Only post alerts from this confidence",
  })
  async confidence(
    @SlashChoice(...ALERT_CONFIDENCES)
    @SlashOption({
      name: "level",
      description: "How much the sharp market behind the fair price takes",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    level: string,
    interaction: CommandInteraction,
  ) {
    const guildId = interaction.guildId;
    if (!guildId || !isAlertConfidence(level)) return;
    await updateGuildSettings(guildId, { minConfidence: level });
    const name = ALERT_CONFIDENCES.find((c) => c.value === level)?.name;
    await replyEphemeral(interaction, `Minimum confidence is now ${name}.`);
  }

  @Slash({ name: "arbs", description: "Turn arb alerts on or off" })
  async arbs(
    @SlashOption({
      name: "enabled",
      description: "Post arbs",
      required: true,
      type: ApplicationCommandOptionType.Boolean,
    })
    enabled: boolean,
    @SlashOption({
      name: "channel",
      description: "Channel for arbs (default the alert channel)",
      required: false,
      type: ApplicationCommandOptionType.Channel,
      channelTypes: FEED_CHANNEL_TYPES,
    })
    channel: { id: string } | undefined,
    @SlashOption({
      name: "min_profit",
      description: "Minimum guaranteed profit in percent (default 1)",
      required: false,
      type: ApplicationCommandOptionType.Number,
      minValue: 0.1,
      maxValue: 20,
    })
    minProfit: number | undefined,
    interaction: CommandInteraction,
  ) {
    const guild = interaction.guild;
    if (!guild) return;
    if (channel && !feedChannel(guild, channel.id)) {
      await replyEphemeral(
        interaction,
        `I cannot post in <#${channel.id}>. Give me View Channel, Send Messages and Embed Links there.`,
      );
      return;
    }
    const s = await updateGuildSettings(guild.id, {
      arbs: enabled,
      ...(channel ? { arbsChannelId: channel.id } : {}),
      ...(minProfit !== undefined ? { minArbProfit: minProfit / 100 } : {}),
    });
    if (!enabled) {
      await replyEphemeral(interaction, "Arb alerts are off.");
      return;
    }
    const target = s.arbsChannelId ?? s.channelId;
    await replyEphemeral(
      interaction,
      target
        ? `Arbs from ${percent(s.minArbProfit)} will post in <#${target}>.`
        : `Arbs from ${percent(s.minArbProfit)} are on and post once \`/alerts channel\` is set.`,
    );
  }

  @Slash({ name: "status", description: "Show this server's alert settings" })
  async status(interaction: CommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    await interaction
      .reply({
        embeds: [alertSettingsEmbed(guildSettings(guildId))],
        flags: [MessageFlags.Ephemeral],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  @Slash({
    name: "test",
    description: "Preview an alert with this server's filters, only you see it",
  })
  async test(interaction: CommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) return;
    if (
      !(await safeDeferReply(interaction, { flags: [MessageFlags.Ephemeral] }))
    )
      return;
    let preview: Awaited<ReturnType<typeof previewAlert>>;
    try {
      preview = await previewAlert(guildSettings(guildId));
    } catch (err) {
      logger.warn("Alert preview failed", { error: String(err) });
      await safeEditReply(
        interaction,
        "The alert feed is unavailable right now. Try again in a moment.",
      );
      return;
    }
    if (!preview) {
      await safeEditReply(interaction, "The ledger has no alerts yet.");
      return;
    }
    await safeEditReply(interaction, {
      content: preview.matched
        ? "Preview of the newest alert your filters let through. Nothing was posted."
        : "No recent alert passes your filters, so this is the newest alert. Nothing was posted.",
      embeds: preview.message.embeds,
      components: preview.message.components,
      allowedMentions: { parse: [] },
    });
  }
}
