import { type AlertMessage, alertMessage } from "@/core/embeds/alert.embed";
import { arbMessage } from "@/core/embeds/arb.embed";
import {
  DEFAULT_SETTINGS,
  type GuildAlertSettings,
  allGuildSettings,
  loadGuildSettings,
  wantsAlert,
  wantsArb,
} from "@/core/services/guild-settings";
import { type FeedChannel, feedChannel } from "@/core/utils/channel.utils";
import { logger } from "@/lib/logger";
import {
  type LedgerEntry,
  type ValueBet,
  fetchArbs,
  fetchLedger,
  fetchValueBet,
} from "@/lib/openev/client";
import { dataFile, isRecord, readJson, writeJson } from "@/lib/state";
import { PROOF_URL } from "@/shared/config/openev";
import type { Client } from "discord.js";

const INTERVAL_MS = 15_000;
// Mirrors the default row limit of GET /v1/ledger.
const LEDGER_PAGE = 500;
const MAX_PER_TICK = 20;
// An arb that stays away this long is posted again when it returns.
const ARB_FORGET_MS = 6 * 60 * 60 * 1000;
const FILE = dataFile("openev-alerts.json");

// The API stamps every alert of one snapshot with the same time, so the watermark keeps the ids at `since`.
interface Watermark {
  since: string;
  seen: string[];
}

interface FeedState {
  // Null until the first poll, which marks the current ledger as seen instead of posting it.
  ledger: Watermark | null;
  // Arb id to the last time it was listed.
  arbs: Record<string, string> | null;
}

interface Target {
  name: string;
  settings: GuildAlertSettings;
  sendAlert: (message: AlertMessage) => Promise<void>;
  // Null when arbs are off for this target.
  sendArb: ((message: AlertMessage) => Promise<void>) | null;
  sendText: (content: string) => Promise<void>;
}

let state: FeedState = { ledger: null, arbs: null };
let running = false;

function parseState(value: unknown): FeedState {
  if (!isRecord(value)) return { ledger: null, arbs: null };
  const ledger = isRecord(value.ledger) ? value.ledger : null;
  const since =
    ledger && typeof ledger.since === "string" ? ledger.since : null;
  const seen = ledger && Array.isArray(ledger.seen) ? ledger.seen : [];
  const arbs: Record<string, string> = {};
  if (isRecord(value.arbs)) {
    for (const [id, at] of Object.entries(value.arbs)) {
      if (typeof at === "string") arbs[id] = at;
    }
  }
  return {
    ledger:
      since && !Number.isNaN(Date.parse(since))
        ? {
            since,
            seen: seen.filter((id): id is string => typeof id === "string"),
          }
        : null,
    arbs: isRecord(value.arbs) ? arbs : null,
  };
}

function watermarkOf(entries: LedgerEntry[]): Watermark | null {
  let newest = Number.NEGATIVE_INFINITY;
  let since = "";
  for (const e of entries) {
    const at = Date.parse(e.alerted_at);
    if (at > newest) {
      newest = at;
      since = e.alerted_at;
    }
  }
  if (!since) return null;
  return {
    since,
    seen: entries
      .filter((e) => Date.parse(e.alerted_at) === newest)
      .map((e) => e.id),
  };
}

function freshEntries(entries: LedgerEntry[], mark: Watermark): LedgerEntry[] {
  const sinceMs = Date.parse(mark.since);
  const seen = new Set(mark.seen);
  return entries
    .filter((e) => {
      const at = Date.parse(e.alerted_at);
      return at > sinceMs || (at === sinceMs && !seen.has(e.id));
    })
    .sort(
      (a, b) =>
        Date.parse(a.alerted_at) - Date.parse(b.alerted_at) ||
        a.id.localeCompare(b.id),
    );
}

// Undefined when the API could not be asked; the embed then leaves the live price out.
async function liveBet(id: string): Promise<ValueBet | null | undefined> {
  try {
    return await fetchValueBet(id);
  } catch (err) {
    logger.warn("Value bet lookup failed", { id, error: String(err) });
    return undefined;
  }
}

async function postAlerts(targets: Target[]): Promise<void> {
  const entries = await fetchLedger(LEDGER_PAGE);
  if (!state.ledger) {
    state.ledger = watermarkOf(entries) ?? {
      since: new Date().toISOString(),
      seen: [],
    };
    logger.info("Alerts feed starts after the current ledger", {
      since: state.ledger.since,
    });
    return;
  }

  const fresh = freshEntries(entries, state.ledger);
  if (fresh.length === 0) return;
  if (fresh.length >= LEDGER_PAGE) {
    logger.warn("More new alerts than one ledger page, older ones skipped", {
      since: state.ledger.since,
    });
  }

  const posted = new Map<Target, number>();
  const overflow = new Map<Target, number>();
  for (const entry of fresh) {
    const wanted = targets.filter((t) => wantsAlert(t.settings, entry));
    const room = wanted.filter((t) => (posted.get(t) ?? 0) < MAX_PER_TICK);
    for (const t of wanted) {
      if (!room.includes(t)) overflow.set(t, (overflow.get(t) ?? 0) + 1);
    }
    if (room.length === 0) continue;
    const message = alertMessage(entry, await liveBet(entry.id));
    for (const t of room) {
      await t.sendAlert(message);
      posted.set(t, (posted.get(t) ?? 0) + 1);
    }
  }
  for (const [t, count] of overflow) {
    await t.sendText(
      `${count} more alerts in this batch were not posted here. Every alert is on the proof page: ${PROOF_URL}`,
    );
  }

  // Advances past failed sends too, so one broken channel never reposts the batch elsewhere.
  state.ledger = watermarkOf(entries) ?? state.ledger;
  logger.info("Alerts posted", {
    fresh: fresh.length,
    targets: posted.size,
  });
}

async function postArbs(targets: Target[]): Promise<void> {
  const arbs = await fetchArbs(0);
  const now = Date.now();
  const known = state.arbs;
  const next: Record<string, string> = {};
  if (known) {
    for (const [id, at] of Object.entries(known)) {
      if (now - Date.parse(at) < ARB_FORGET_MS) next[id] = at;
    }
  }
  for (const arb of arbs) {
    const isNew = known !== null && !(arb.id in next);
    next[arb.id] = new Date(now).toISOString();
    if (!isNew) continue;
    const wanted = targets.filter(
      (t) => t.sendArb && wantsArb(t.settings, arb),
    );
    if (wanted.length === 0) continue;
    const message = arbMessage(arb);
    for (const t of wanted) await t.sendArb?.(message);
  }
  state.arbs = next;
}

async function tick(targets: Target[], persist: boolean): Promise<void> {
  if (running) return;
  running = true;
  try {
    await postAlerts(targets).catch((err) =>
      logger.warn("Alerts poll failed", { error: String(err) }),
    );
    await postArbs(targets).catch((err) =>
      logger.warn("Arbs poll failed", { error: String(err) }),
    );
    if (persist) await writeJson(FILE, state);
  } catch (err) {
    logger.error("Alerts feed tick failed", { error: String(err) });
  } finally {
    running = false;
  }
}

function channelSender(
  channel: FeedChannel,
  guildId: string,
): (message: AlertMessage | string) => Promise<void> {
  return async (message) => {
    const payload =
      typeof message === "string"
        ? { content: message }
        : { embeds: message.embeds, components: message.components };
    await channel
      .send({ ...payload, allowedMentions: { parse: [] } })
      .then(() => undefined)
      .catch((err) =>
        logger.warn("Posting alert failed", {
          guildId,
          channelId: channel.id,
          error: String(err),
        }),
      );
  };
}

function guildTargets(client: Client): Target[] {
  const targets: Target[] = [];
  for (const [guildId, settings] of allGuildSettings()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild || !settings.channelId) continue;
    const channel = feedChannel(guild, settings.channelId);
    if (!channel) continue;
    const arbChannel = settings.arbs
      ? feedChannel(guild, settings.arbsChannelId ?? settings.channelId)
      : null;
    const send = channelSender(channel, guildId);
    targets.push({
      name: guildId,
      settings,
      sendAlert: send,
      sendArb: arbChannel ? channelSender(arbChannel, guildId) : null,
      sendText: send,
    });
  }
  return targets;
}

export async function startAlertsFeed(client: Client): Promise<void> {
  await loadGuildSettings();
  state = parseState(await readJson(FILE));
  void tick(guildTargets(client), true);
  setInterval(() => void tick(guildTargets(client), true), INTERVAL_MS);
}

// The newest alert these settings would get, else the newest alert at all.
export async function previewAlert(
  settings: GuildAlertSettings,
): Promise<{ message: AlertMessage; matched: boolean } | null> {
  const entries = await fetchLedger(100);
  const match = entries.find((e) => wantsAlert(settings, e));
  const entry = match ?? entries[0];
  if (!entry) return null;
  return {
    message: alertMessage(entry, await liveBet(entry.id)),
    matched: match !== undefined,
  };
}

function printMessage(kind: string, message: AlertMessage | string): void {
  const body =
    typeof message === "string"
      ? { content: message }
      : {
          embeds: message.embeds.map((e) => e.toJSON()),
          components: message.components.map((c) => c.toJSON()),
        };
  console.log(JSON.stringify({ dryRun: kind, ...body }, null, 2));
}

// DRY_RUN: no Discord login and no state written; renders to stdout what one guild with default settings and arbs on would get.
export async function runAlertsDryRun(samples: number): Promise<void> {
  const settings: GuildAlertSettings = { ...DEFAULT_SETTINGS, arbs: true };
  for (const entry of (await fetchLedger(samples)).slice(0, samples)) {
    printMessage("sample alert", alertMessage(entry, await liveBet(entry.id)));
  }
  const arb = (await fetchArbs(settings.minArbProfit)).find((a) =>
    wantsArb(settings, a),
  );
  if (arb) printMessage("sample arb", arbMessage(arb));

  const target: Target = {
    name: "dry run",
    settings,
    sendAlert: async (m) => printMessage("alert", m),
    sendArb: async (m) => printMessage("arb", m),
    sendText: async (m) => printMessage("text", m),
  };
  await tick([target], false);
  setInterval(() => void tick([target], false), INTERVAL_MS);
}
