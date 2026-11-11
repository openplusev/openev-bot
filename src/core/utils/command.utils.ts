import {
  type CommandInteraction,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  MessageFlags,
} from "discord.js";

const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_INTERACTION = 10062;

function discordCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return typeof error.code === "number" ? error.code : undefined;
  }
  return undefined;
}

export async function safeDeferReply(
  interaction: CommandInteraction,
  options?: InteractionDeferReplyOptions,
): Promise<boolean> {
  try {
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    if (discordCode(error) === UNKNOWN_INTERACTION) return false;
    throw error;
  }
}

export async function safeEditReply(
  interaction: CommandInteraction,
  options: string | InteractionEditReplyOptions,
): Promise<boolean> {
  try {
    await interaction.editReply(options);
    return true;
  } catch (error) {
    const code = discordCode(error);
    if (
      code === UNKNOWN_MESSAGE ||
      code === UNKNOWN_CHANNEL ||
      code === UNKNOWN_INTERACTION
    ) {
      return false;
    }
    throw error;
  }
}

export function replyEphemeral(
  interaction: CommandInteraction,
  content: string,
): Promise<unknown> {
  return interaction
    .reply({
      content,
      flags: [MessageFlags.Ephemeral],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}
