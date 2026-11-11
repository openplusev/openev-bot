import {
  type AlertMessage,
  kellyName,
  linkRow,
  money,
} from "@/core/embeds/alert.embed";
import {
  findSubscriber,
  isUndeliverable,
  personalAlertsAvailable,
} from "@/core/services/dm-alerts";
import { percent } from "@/core/utils/openev.utils";
import {
  ALERT_CONFIDENCES,
  SETTINGS_URL,
  bookName,
} from "@/shared/config/openev";
import { EmbedBuilder } from "discord.js";

const ON_COLOR = 0x57f287;
const OFF_COLOR = 0x99aab5;
const WARN_COLOR = 0xfee75c;

function embed(color: number, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Your personal alerts")
    .setDescription(description);
}

export function personalAlertsReply(discordId: string): AlertMessage {
  const components = [
    linkRow([{ label: "Alert settings", url: SETTINGS_URL }]),
  ];
  const available = personalAlertsAvailable();
  if (available !== true) {
    return {
      embeds: [
        embed(
          OFF_COLOR,
          available === null
            ? "Personal alerts are loading. Try again in a minute."
            : `Personal DM alerts are not live yet. You can set them up on the [settings page](${SETTINGS_URL}) and they start once they are.`,
        ),
      ],
      components,
    };
  }

  const sub = findSubscriber(discordId);
  if (!sub) {
    return {
      embeds: [
        embed(
          OFF_COLOR,
          `No OpenEV account with alerts is linked to this Discord account. Sign in with Discord on the [settings page](${SETTINGS_URL}), turn on alerts and pick Discord DM.`,
        ),
      ],
      components,
    };
  }

  const p = sub.prefs;
  const on = p.enabled && p.discordDm;
  const blocked = on && isUndeliverable(discordId);
  let status = "On. Matching alerts arrive here by DM.";
  if (!p.enabled) status = "Off. Turn alerts on in your settings.";
  else if (!p.discordDm)
    status = "Off for Discord. Pick Discord DM as a channel in your settings.";
  else if (blocked) {
    status =
      "Paused: I could not DM you. Share a server with me and allow direct messages from server members, then I retry within a few hours.";
  }

  const confidence =
    ALERT_CONFIDENCES.find((c) => c.value === p.minConfidence)?.name ??
    p.minConfidence;
  const books = p.books.length
    ? p.books.map((b) => `${bookName(b)} (${b})`).join(", ")
    : "All books";
  const stake =
    sub.bankroll === null
      ? "No bankroll set, stakes show per 1000"
      : `${kellyName(sub.kellyFraction)} of ${money(sub.bankroll, sub.currency)}`;

  return {
    embeds: [
      embed(blocked ? WARN_COLOR : on ? ON_COLOR : OFF_COLOR, status)
        .addFields(
          { name: "Minimum EV", value: percent(p.minEv), inline: true },
          { name: "Minimum confidence", value: confidence, inline: true },
          {
            name: "Arbs",
            value: p.arbs ? `On from ${percent(p.minArbProfit)}` : "Off",
            inline: true,
          },
          { name: "Stake", value: stake, inline: true },
          { name: "Books", value: books.slice(0, 1024) },
        )
        .setFooter({
          text: "Change these on the settings page. Updates reach the bot within a minute.",
        }),
    ],
    components,
  };
}
