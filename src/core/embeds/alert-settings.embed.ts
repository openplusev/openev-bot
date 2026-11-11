import type { GuildAlertSettings } from "@/core/services/guild-settings";
import { percent } from "@/core/utils/openev.utils";
import { ALERT_CONFIDENCES, PROOF_URL, bookName } from "@/shared/config/openev";
import { EmbedBuilder } from "discord.js";

function channel(id: string | null, fallback: string): string {
  return id ? `<#${id}>` : fallback;
}

export function alertSettingsEmbed(s: GuildAlertSettings): EmbedBuilder {
  const confidence =
    ALERT_CONFIDENCES.find((c) => c.value === s.minConfidence)?.name ??
    s.minConfidence;
  const books = s.books.length
    ? s.books.map((b) => `${bookName(b)} (${b})`).join(", ")
    : "All books";
  const arbs = s.arbs
    ? `On from ${percent(s.minArbProfit)} in ${channel(s.arbsChannelId ?? s.channelId, "no channel yet")}`
    : "Off";
  return new EmbedBuilder()
    .setColor(s.channelId ? 0x57f287 : 0x99aab5)
    .setTitle("Value bet alerts")
    .setDescription(
      s.channelId
        ? `Alerts post to ${channel(s.channelId, "")} as the [public ledger](${PROOF_URL}) records them.`
        : "Alerts are off. Turn them on with `/alerts channel`.",
    )
    .addFields(
      { name: "Minimum EV", value: percent(s.minEv), inline: true },
      { name: "Minimum confidence", value: confidence, inline: true },
      { name: "Arbs", value: arbs, inline: true },
      { name: "Books", value: books.slice(0, 1024) },
    );
}
