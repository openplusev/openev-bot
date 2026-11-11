import {
  ChannelType,
  type Guild,
  type NewsChannel,
  PermissionFlagsBits,
  type TextChannel,
} from "discord.js";

export type FeedChannel = TextChannel | NewsChannel;

export const FEED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

// Null when the channel is gone or the bot cannot post embeds there.
export function feedChannel(
  guild: Guild,
  channelId: string,
): FeedChannel | null {
  const me = guild.members.me;
  const channel = guild.channels.cache.get(channelId);
  if (!me || !channel) return null;
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    return null;
  }
  const allowed = channel
    .permissionsFor(me)
    .has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
  return allowed ? channel : null;
}
