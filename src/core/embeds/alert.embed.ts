import {
  decimalOdds,
  kelly,
  leagueName,
  marketName,
  percent,
  sideName,
  unixSeconds,
} from "@/core/utils/openev.utils";
import type { LedgerEntry, ValueBet } from "@/lib/openev/client";
import {
  CONFIDENCE_COLOR,
  CONFIDENCE_LABEL,
  betUrl,
  bookName,
  gameUrl,
} from "@/shared/config/openev";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

export const CHECK_PRICE = "Check the price at the book before betting.";

export interface AlertMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

// A personal stake: whole amounts of the user's bankroll in their currency.
export interface Staking {
  bankroll: number;
  kellyFraction: number;
  currency: string;
}

const CHANNEL_BANKROLL = 1000;
const CHANNEL_KELLY = 0.25;

const KELLY_NAMES: Record<number, string> = {
  1: "Full Kelly",
  0.5: "Half Kelly",
  0.25: "Quarter Kelly",
  0.125: "Eighth Kelly",
};

export function kellyName(fraction: number): string {
  return KELLY_NAMES[fraction] ?? `${fraction}x Kelly`;
}

export function money(amount: number, currency: string): string {
  return `${Math.round(amount).toLocaleString("en-US")} ${currency}`;
}

export function linkRow(
  links: { label: string; url: string }[],
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    links.map((l) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(l.label)
        .setURL(l.url),
    ),
  );
}

function stakeField(
  odds: number,
  fair: number,
  staking: Staking | undefined,
): { name: string; value: string; inline: true } {
  if (!staking) {
    const stake = Math.round(
      kelly(odds, 1 / fair, CHANNEL_KELLY) * CHANNEL_BANKROLL,
    );
    return {
      name: kellyName(CHANNEL_KELLY),
      value: `${stake} per ${CHANNEL_BANKROLL}`,
      inline: true,
    };
  }
  const stake = kelly(odds, 1 / fair, staking.kellyFraction) * staking.bankroll;
  return {
    name: "Your stake",
    value: `**${money(stake, staking.currency)}**\n${kellyName(staking.kellyFraction)} of ${money(staking.bankroll, staking.currency)}`,
    inline: true,
  };
}

// `live` is the bet as the API sees it now: null once the price is gone, undefined when unknown.
export function alertMessage(
  entry: LedgerEntry,
  live: ValueBet | null | undefined,
  staking?: Staking,
): AlertMessage {
  const odds = Number(entry.alert_odds);
  const fair = Number(entry.alert_fair_odds);
  const kickoff = unixSeconds(entry.starts_at);
  const samePrice = live != null && Number(live.odds) === odds;

  let oddsValue = `**${decimalOdds(odds)}**\nfair ${decimalOdds(fair)}`;
  if (live && !samePrice) oddsValue += `\nnow ${decimalOdds(live.odds)}`;
  if (live === null) oddsValue += "\nprice gone";

  const evValue = samePrice
    ? `**${percent(entry.alert_ev)}**\nsafe ${percent(live.ev_conservative)}`
    : `**${percent(entry.alert_ev)}**`;

  const embed = new EmbedBuilder()
    .setColor(CONFIDENCE_COLOR[entry.confidence])
    .setAuthor({ name: leagueName(entry.league) })
    .setTitle(`${sideName(entry)} at ${bookName(entry.book)}`.slice(0, 256))
    .setURL(betUrl(entry.id))
    .setDescription(`${entry.home} vs ${entry.away}\n${marketName(entry)}`)
    .addFields(
      { name: "Odds", value: oddsValue, inline: true },
      { name: "EV", value: evValue, inline: true },
      {
        name: "Confidence",
        value: CONFIDENCE_LABEL[entry.confidence],
        inline: true,
      },
      stakeField(odds, fair, staking),
      {
        name: "Kickoff",
        value: `<t:${kickoff}:f>\n<t:${kickoff}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: CHECK_PRICE })
    .setTimestamp(new Date(entry.alerted_at));

  return {
    embeds: [embed],
    components: [
      linkRow([
        { label: "Bet details", url: betUrl(entry.id) },
        { label: "Game", url: gameUrl(entry.game_id) },
      ]),
    ],
  };
}
