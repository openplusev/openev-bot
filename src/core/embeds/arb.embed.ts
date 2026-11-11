import {
  type AlertMessage,
  CHECK_PRICE,
  linkRow,
} from "@/core/embeds/alert.embed";
import {
  decimalOdds,
  leagueName,
  marketName,
  percent,
  sideName,
  unixSeconds,
} from "@/core/utils/openev.utils";
import type { Arb } from "@/lib/openev/client";
import { ARBS_URL, ARB_COLOR, bookName, gameUrl } from "@/shared/config/openev";
import { EmbedBuilder } from "discord.js";

const TOTAL_STAKE = 1000;

export function arbMessage(arb: Arb): AlertMessage {
  const kickoff = unixSeconds(arb.starts_at);
  const legs = arb.legs.map((leg) => ({
    name: `${sideName({ ...arb, side: leg.side })} at ${bookName(leg.book)}`.slice(
      0,
      256,
    ),
    value: `**${decimalOdds(leg.odds)}**\nstake ${Math.round(leg.stake_share * TOTAL_STAKE)} of ${TOTAL_STAKE}`,
    inline: true,
  }));

  const embed = new EmbedBuilder()
    .setColor(ARB_COLOR)
    .setAuthor({ name: leagueName(arb.league) })
    .setTitle(
      `Arb ${percent(arb.profit)}: ${arb.home} vs ${arb.away}`.slice(0, 256),
    )
    .setURL(ARBS_URL)
    .setDescription(
      `${marketName(arb)}\nKickoff <t:${kickoff}:f>, <t:${kickoff}:R>`,
    )
    .addFields(legs)
    .setFooter({ text: CHECK_PRICE })
    .setTimestamp(new Date());

  return {
    embeds: [embed],
    components: [
      linkRow([
        { label: "All arbs", url: ARBS_URL },
        { label: "Game", url: gameUrl(arb.game_id) },
      ]),
    ],
  };
}
