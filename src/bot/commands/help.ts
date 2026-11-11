import { linkRow } from "@/core/embeds/alert.embed";
import {
  LEDGER_MIN_EV,
  OPENEV_WEBSITE_URL,
  PROOF_URL,
  SETTINGS_URL,
} from "@/shared/config/openev";
import {
  CommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import { Discord, Slash } from "discordx";

const HELP_COLOR = 0x5865f2;

@Discord()
export class HelpCommand {
  @Slash({
    name: "help",
    description: "What this bot does and its commands",
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
  })
  async help(interaction: CommandInteraction) {
    const embed = new EmbedBuilder()
      .setColor(HELP_COLOR)
      .setTitle("OpenEV alerts")
      .setDescription(
        `I post OpenEV value bets the moment the [public ledger](${PROOF_URL}) records them (from +${LEDGER_MIN_EV * 100}% EV), and arbs if a server turns them on. Every alert links to the bet and the game on [OpenEV](${OPENEV_WEBSITE_URL}).`,
      )
      .addFields(
        {
          name: "Personal alerts by DM",
          value: `Sign in with Discord on the [settings page](${SETTINGS_URL}), turn on alerts, pick Discord DM and set your filters, bankroll and Kelly fraction. Stakes in your DMs are sized from your bankroll.\n\`/alerts me\` shows your status.`,
        },
        {
          name: "Server alerts (Manage Server)",
          value: [
            "`/alerts channel` post alerts in a channel",
            "`/alerts min_ev` minimum EV in percent",
            "`/alerts books` only these books, or all",
            "`/alerts confidence` minimum confidence: low, medium or high",
            "`/alerts arbs` arbs on or off, own channel, minimum profit",
            "`/alerts status` this server's settings",
            "`/alerts test` preview the newest matching alert, only to you",
            "`/alerts stop` stop posting, filters are kept",
          ].join("\n"),
        },
      )
      .setFooter({ text: "Check the price at the book before betting." });

    await interaction
      .reply({
        embeds: [embed],
        components: [
          linkRow([
            { label: "Alert settings", url: SETTINGS_URL },
            { label: "Proof page", url: PROOF_URL },
          ]),
        ],
        flags: [MessageFlags.Ephemeral],
      })
      .catch(() => {});
  }
}
