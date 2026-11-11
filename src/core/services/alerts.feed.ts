import { type AlertMessage, alertMessage } from "@/core/embeds/alert.embed";
import { arbMessage } from "@/core/embeds/arb.embed";
import { dmAlert, dmArb } from "@/core/services/dm-alerts";
import {
  type GuildAlertSettings,
  allGuildSettings,
  wantsAlert,
  wantsArb,
} from "@/core/services/guild-settings";
import { type FeedChannel, feedChannel } from "@/core/utils/channel.utils";
import { logger } from "@/lib/logger";
import {
  type Arb,
  type LedgerEntry,
  type ValueBet,
  fetchLedger,
  fetchValueBet,
} from "@/lib/openev/client";
import { type FeedEvent, connectLive } from "@/lib/openev/live";
import { dataFile, isRecord, readJson, writeJson } from "@/lib/state";
import { PROOF_URL } from "@/shared/config/openev";
import type { Client } from "discord.js";

// Mirrors the default row limit of GET /v1/ledger.
const LEDGER_PAGE = 500;
const MAX_PER_BATCH = 20;
// One snapshot sends its ledger_added events back to back; they are posted as one batch.
const BATCH_WAIT_MS = 500;
// An arb that stays away this long is posted again when it returns.
const ARB_FORGET_MS = 6 * 60 * 60 * 1000;
const FILE = dataFile("openev-alerts.json");

// The API stamps every alert of one snapshot with the same time, so the watermark keeps the ids at `since`.
interface Watermark {
  since: string;
  seen: string[];
}

interface FeedState {
  // Null until the first catch up, which marks the current ledger as seen instead of posting it.
  ledger: Watermark | null;
  // Arb id to the last time it was listed; null until the first arbs snapshot.
  arbs: Record<string, string> | null;
}

export interface Target {
  name: string;
  settings: GuildAlertSettings;
  sendAlert: (message: AlertMessage) => Promise<void>;
  // Null when arbs are off for this target.
  sendArb: ((message: AlertMessage) => Promise<void>) | null;
  sendText: (content: string) => Promise<void>;
}

export interface FeedSinks {
  targets: () => Target[];
  persist: boolean;
}

let state: FeedState = { ledger: null, arbs: null };
// Every change to `state` runs through this chain, so catch up and live events never interleave.
let chain: Promise<void> = Promise.resolve();
let pending: LedgerEntry[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

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

function isFresh(e: LedgerEntry, mark: Watermark): boolean {
  const at = Date.parse(e.alerted_at);
  const sinceMs = Date.parse(mark.since);
  return at > sinceMs || (at === sinceMs && !mark.seen.includes(e.id));
}

function advance(mark: Watermark, e: LedgerEntry): Watermark {
  const at = Date.parse(e.alerted_at);
  const sinceMs = Date.parse(mark.since);
  if (at > sinceMs) return { since: e.alerted_at, seen: [e.id] };
  if (at === sinceMs && !mark.seen.includes(e.id)) {
    return { since: mark.since, seen: [...mark.seen, e.id] };
  }
  return mark;
}

// Undefined when the API could not be asked; the embed then leaves the live price out.
export async function liveBet(
  id: string,
): Promise<ValueBet | null | undefined> {
  try {
    return await fetchValueBet(id);
  } catch (err) {
    logger.warn("Value bet lookup failed", { id, error: String(err) });
    return undefined;
  }
}

function run(sinks: FeedSinks, job: () => Promise<void>): void {
  chain = chain
    .then(job)
    .catch((err) =>
      logger.error("Alerts feed job failed", { error: String(err) }),
    )
    .then(() => (sinks.persist ? writeJson(FILE, state) : undefined));
}

// Posts the entries the watermark has not seen, oldest first, at most MAX_PER_BATCH per target.
async function deliverBatch(
  sinks: FeedSinks,
  entries: LedgerEntry[],
): Promise<void> {
  const start = state.ledger;
  if (!start) return;
  const fresh = entries
    .filter((e) => isFresh(e, start))
    .sort(
      (a, b) =>
        Date.parse(a.alerted_at) - Date.parse(b.alerted_at) ||
        a.id.localeCompare(b.id),
    );
  if (fresh.length === 0) return;

  const targets = sinks.targets();
  const posted = new Map<Target, number>();
  const overflow = new Map<Target, number>();
  let mark = start;
  let count = 0;
  for (const entry of fresh) {
    // A repeated event inside one batch is already behind the advanced mark.
    if (!isFresh(entry, mark)) continue;
    // Advances before sending, so one broken channel never reposts the batch elsewhere.
    mark = advance(mark, entry);
    state.ledger = mark;
    count++;
    const live = await liveBet(entry.id);
    dmAlert(entry, live);
    const wanted = targets.filter((t) => wantsAlert(t.settings, entry));
    const room = wanted.filter((t) => (posted.get(t) ?? 0) < MAX_PER_BATCH);
    for (const t of wanted) {
      if (!room.includes(t)) overflow.set(t, (overflow.get(t) ?? 0) + 1);
    }
    if (room.length === 0) continue;
    const message = alertMessage(entry, live);
    for (const t of room) {
      await t.sendAlert(message);
      posted.set(t, (posted.get(t) ?? 0) + 1);
    }
  }
  for (const [t, skipped] of overflow) {
    await t.sendText(
      `${skipped} more alerts in this batch were not posted here. Every alert is on the proof page: ${PROOF_URL}`,
    );
  }
  logger.info("Alerts posted", { fresh: count, targets: posted.size });
}

async function catchUp(sinks: FeedSinks): Promise<void> {
  const entries = await fetchLedger(LEDGER_PAGE);
  const mark = state.ledger;
  if (!mark) {
    state.ledger = watermarkOf(entries) ?? {
      since: new Date().toISOString(),
      seen: [],
    };
    logger.info("Alerts feed starts after the current ledger", {
      since: state.ledger.since,
    });
    return;
  }
  const missed = entries.filter((e) => isFresh(e, mark)).length;
  if (missed >= LEDGER_PAGE) {
    logger.warn("More missed alerts than one ledger page, older ones skipped", {
      since: mark.since,
    });
  }
  if (missed) logger.info("Catching up on missed alerts", { missed });
  await deliverBatch(sinks, entries);
}

async function postArb(sinks: FeedSinks, arb: Arb): Promise<void> {
  dmArb(arb);
  const message = arbMessage(arb);
  for (const t of sinks.targets()) {
    if (t.sendArb && wantsArb(t.settings, arb)) await t.sendArb(message);
  }
}

// Sent on every (re)connect: arbs not listed recently are new; the very first snapshot only seeds.
async function arbsSnapshot(sinks: FeedSinks, arbs: Arb[]): Promise<void> {
  const now = Date.now();
  const known = state.arbs;
  const next: Record<string, string> = {};
  if (known) {
    for (const [id, at] of Object.entries(known)) {
      if (now - Date.parse(at) < ARB_FORGET_MS) next[id] = at;
    }
  }
  const fresh = known ? arbs.filter((a) => !(a.id in next)) : [];
  for (const arb of arbs) next[arb.id] = new Date(now).toISOString();
  state.arbs = next;
  for (const arb of fresh) await postArb(sinks, arb);
}

async function arbSeen(
  sinks: FeedSinks,
  arb: Arb,
  added: boolean,
): Promise<void> {
  const known = state.arbs;
  if (!known) return;
  const at = known[arb.id];
  const isNew = added && (!at || Date.now() - Date.parse(at) >= ARB_FORGET_MS);
  known[arb.id] = new Date().toISOString();
  if (isNew) await postArb(sinks, arb);
}

function onEvent(sinks: FeedSinks, event: FeedEvent): void {
  switch (event.type) {
    case "ledger_added":
      pending.push(event.entry);
      pendingTimer ??= setTimeout(() => {
        const batch = pending;
        pending = [];
        pendingTimer = null;
        run(sinks, () => deliverBatch(sinks, batch));
      }, BATCH_WAIT_MS);
      return;
    case "arbs_snapshot":
      run(sinks, () => arbsSnapshot(sinks, event.arbs));
      return;
    case "arb_added":
    case "arb_updated":
      run(sinks, () => arbSeen(sinks, event.arb, event.type === "arb_added"));
      return;
    case "arb_removed":
      run(sinks, async () => {
        if (state.arbs) state.arbs[event.id] = new Date().toISOString();
      });
      return;
  }
}

// Live from /v1/ws; every (re)connect first replays what GET /v1/ledger has past the watermark.
export async function runAlertsFeed(sinks: FeedSinks): Promise<void> {
  if (sinks.persist) state = parseState(await readJson(FILE));
  connectLive({
    onReady: () =>
      run(sinks, () =>
        catchUp(sinks).catch((err) =>
          logger.warn("Ledger catch up failed", { error: String(err) }),
        ),
      ),
    onEvent: (event) => onEvent(sinks, event),
  });
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

export function guildTargets(client: Client): Target[] {
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
