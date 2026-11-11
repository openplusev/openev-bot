import { resultEmbed } from "@/core/embeds/result.embed";
import { ApiError, api, type ApiSettledPick } from "@/lib/api";
import { logger } from "@/lib/logger";
import { dataFile, isRecord, readJson, writeJson } from "@/lib/state";
import {
  ChannelType,
  type Client,
  type Guild,
  PermissionFlagsBits,
  type TextChannel,
} from "discord.js";

const INTERVAL_MS = 5 * 60 * 1000;
const MAX_PER_TICK = 50;
// Mirrors the row limit of GET /picks/settled.
const API_PAGE = 100;
const CHANNEL_NAME = (
  process.env.RESULTS_CHANNEL?.trim() || "results"
).toLowerCase();
const STATE_FILE = dataFile("results-watermarks.json");

// Grading stamps a whole batch with one time, so the watermark keeps the ids already posted at `since`.
interface Watermark {
  since: string;
  seen: string[];
}

const watermarks = new Map<string, Watermark>();
let running = false;
let missingEndpointLogged = false;

async function loadWatermarks(): Promise<void> {
  const parsed = await readJson(STATE_FILE);
  if (!isRecord(parsed)) return;
  for (const [guildId, value] of Object.entries(parsed)) {
    const mark = parseWatermark(value);
    if (mark) watermarks.set(guildId, mark);
  }
  logger.info("Results watermarks loaded", { guilds: watermarks.size });
}

// Older files hold a bare ISO string per guild.
function parseWatermark(value: unknown): Watermark | null {
  if (typeof value === "string") {
    return Number.isNaN(Date.parse(value)) ? null : { since: value, seen: [] };
  }
  if (typeof value !== "object" || value === null) return null;
  const since = "since" in value ? value.since : null;
  const seen = "seen" in value ? value.seen : null;
  if (typeof since !== "string" || Number.isNaN(Date.parse(since))) return null;
  return {
    since,
    seen: Array.isArray(seen)
      ? seen.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function advance(mark: Watermark, pick: ApiSettledPick): Watermark {
  if (Date.parse(pick.settledAt) === Date.parse(mark.since)) {
    return { since: mark.since, seen: [...mark.seen, pick.id] };
  }
  return { since: pick.settledAt, seen: [pick.id] };
}

function byIdNumber(a: ApiSettledPick, b: ApiSettledPick): number {
  return Number(a.id) - Number(b.id);
}

function saveWatermarks(): Promise<void> {
  return writeJson(STATE_FILE, Object.fromEntries(watermarks));
}

function resultsChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;
  return (
    guild.channels.cache.find(
      (c): c is TextChannel =>
        c.type === ChannelType.GuildText &&
        c.name.toLowerCase().includes(CHANNEL_NAME) &&
        c
          .permissionsFor(me)
          .has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
    ) ?? null
  );
}

// Returns false when the endpoint is not deployed, so the tick stops early.
async function pollGuild(guild: Guild): Promise<boolean> {
  const channel = resultsChannel(guild);
  if (!channel) return true;

  let mark = watermarks.get(guild.id);
  if (!mark) {
    // First sight starts now, so adding the bot never floods old results.
    mark = { since: new Date().toISOString(), seen: [] };
    watermarks.set(guild.id, mark);
    await saveWatermarks();
  }
  const sinceMs = Date.parse(mark.since);

  let picks: ApiSettledPick[];
  try {
    // The API filters strictly after `since`, so ask from 1 ms earlier to reach the rest of the batch.
    picks = await api.settledPicks(guild.id, new Date(sinceMs - 1));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      if (!missingEndpointLogged) {
        logger.info("Settled picks endpoint not available yet");
        missingEndpointLogged = true;
      }
      return false;
    }
    logger.warn("Settled picks fetch failed", {
      guildId: guild.id,
      error: String(err),
    });
    return true;
  }
  missingEndpointLogged = false;

  const seen = new Set(mark.seen);
  const fresh = picks
    .filter((p) => {
      if (p.result === "pending" || p.disqualified) return false;
      const at = Date.parse(p.settledAt);
      return at > sinceMs || (at === sinceMs && !seen.has(p.id));
    })
    .sort(
      (a, b) =>
        Date.parse(a.settledAt) - Date.parse(b.settledAt) || byIdNumber(a, b),
    )
    .slice(0, MAX_PER_TICK);

  if (fresh.length === 0 && picks.length >= API_PAGE) {
    // A full page of already posted picks at one time: the API has no cursor past it.
    logger.warn("Results feed skipped picks it cannot page past", {
      guildId: guild.id,
      since: mark.since,
    });
    watermarks.set(guild.id, {
      since: new Date(sinceMs + 1).toISOString(),
      seen: [],
    });
    await saveWatermarks();
    return true;
  }

  for (const pick of fresh) {
    await channel
      .send({ embeds: [resultEmbed(pick)], allowedMentions: { parse: [] } })
      .catch((err) =>
        logger.warn("Posting result failed", {
          guildId: guild.id,
          pickId: pick.id,
          error: String(err),
        }),
      );
    mark = advance(mark, pick);
    watermarks.set(guild.id, mark);
  }
  if (fresh.length) await saveWatermarks();
  return true;
}

async function tick(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!(await pollGuild(guild))) break;
    }
  } catch (err) {
    logger.error("Results feed tick failed", { error: String(err) });
  } finally {
    running = false;
  }
}

export async function startResultsFeed(client: Client): Promise<void> {
  await loadWatermarks();
  void tick(client);
  setInterval(() => void tick(client), INTERVAL_MS);
}
