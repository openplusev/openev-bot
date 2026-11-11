import {
  type AlertMessage,
  type Staking,
  alertMessage,
  money,
} from "@/core/embeds/alert.embed";
import { arbMessage } from "@/core/embeds/arb.embed";
import { wantsAlert, wantsArb } from "@/core/services/guild-settings";
import { kelly, percent } from "@/core/utils/openev.utils";
import { logger } from "@/lib/logger";
import type { Arb, LedgerEntry, ValueBet } from "@/lib/openev/client";
import {
  type DeliveryResult,
  InternalApiError,
  type Subscriber,
} from "@/lib/openev/internal";
import { meetsConfidence } from "@/shared/config/openev";
import { setTimeout as sleep } from "node:timers/promises";

export interface DmDecision {
  kind: "alert" | "arb";
  id: string;
  userId: string | number;
  discordId: string;
  displayName: string;
  decision:
    "skip" | "queued" | "sent" | "duplicate" | "failed" | "undeliverable";
  reason?: string;
  stake?: string;
}

export interface DmDeps {
  fetchSubscribers: () => Promise<Subscriber[]>;
  recordDelivery: (
    userId: string | number,
    ledgerId: string,
  ) => Promise<DeliveryResult>;
  send: (discordId: string, message: AlertMessage) => Promise<void>;
  onDecision: (decision: DmDecision) => void;
}

interface Job {
  kind: DmDecision["kind"];
  // The delivery key: the ledger id, or `arb:<id>` for arbs.
  deliveryId: string;
  sub: Subscriber;
  message: AlertMessage;
  stake?: string;
}

const REFRESH_MS = 60_000;
// Five DMs a second stays far below Discord's global 50 requests a second, opening a DM channel included.
const SPACING_MS = 200;
const MAX_QUEUE = 1_000;
// A user who opens their DMs later gets alerts again after this long.
const UNDELIVERABLE_RETRY_MS = 6 * 60 * 60 * 1000;
// Cannot send messages to this user, no mutual guilds, unknown user.
const CANNOT_DM = new Set([50007, 50278, 10013]);

let deps: DmDeps | null = null;
let subscribers: Subscriber[] = [];
// Null until the first successful load; false while the endpoint is missing.
let available: boolean | null = null;
let refreshing = false;
const undeliverable = new Map<string, number>();
const loggedUndeliverable = new Set<string>();
const queue: Job[] = [];
let draining = false;

function discordCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return typeof err.code === "number" ? err.code : undefined;
  }
  return undefined;
}

async function refresh(): Promise<void> {
  if (!deps || refreshing) return;
  refreshing = true;
  try {
    subscribers = await deps.fetchSubscribers();
    if (available !== true) {
      logger.info("Alert subscribers loaded", { count: subscribers.length });
    }
    available = true;
  } catch (err) {
    if (err instanceof InternalApiError && err.status === 404) {
      if (available !== false) {
        logger.info("Alert subscribers endpoint not deployed yet, DMs off");
      }
      available = false;
      subscribers = [];
    } else {
      // Keeps the last list, so an API restart does not pause DMs.
      logger.warn("Loading alert subscribers failed", { error: String(err) });
    }
  } finally {
    refreshing = false;
  }
}

export async function startDmAlerts(d: DmDeps): Promise<void> {
  deps = d;
  await refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

export function personalAlertsAvailable(): boolean | null {
  return deps ? available : false;
}

export function findSubscriber(discordId: string): Subscriber | null {
  return subscribers.find((s) => s.discordId === discordId) ?? null;
}

export function isUndeliverable(discordId: string): boolean {
  const until = undeliverable.get(discordId);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  undeliverable.delete(discordId);
  return false;
}

export function stakingOf(sub: Subscriber): Staking | undefined {
  return sub.bankroll === null
    ? undefined
    : {
        bankroll: sub.bankroll,
        kellyFraction: sub.kellyFraction,
        currency: sub.currency,
      };
}

function baseSkip(sub: Subscriber): string | null {
  if (!sub.prefs.enabled) return "alerts disabled";
  if (!sub.prefs.discordDm) return "discord dm channel off";
  if (isUndeliverable(sub.discordId)) return "cannot be DMed, retried later";
  return null;
}

export function alertSkipReason(
  sub: Subscriber,
  e: LedgerEntry,
): string | null {
  const base = baseSkip(sub);
  if (base) return base;
  if (wantsAlert(sub.prefs, e)) return null;
  if (e.alert_ev < sub.prefs.minEv) {
    return `ev ${percent(e.alert_ev)} below ${percent(sub.prefs.minEv)}`;
  }
  if (!meetsConfidence(e.confidence, sub.prefs.minConfidence)) {
    return `confidence ${e.confidence} below ${sub.prefs.minConfidence}`;
  }
  return `book ${e.book} not chosen`;
}

export function arbSkipReason(sub: Subscriber, arb: Arb): string | null {
  const base = baseSkip(sub);
  if (base) return base;
  if (wantsArb(sub.prefs, arb)) return null;
  if (!sub.prefs.arbs) return "arbs off";
  if (arb.check) return "arb flagged check";
  if (arb.profit < sub.prefs.minArbProfit) {
    return `profit ${percent(arb.profit)} below ${percent(sub.prefs.minArbProfit)}`;
  }
  return "a leg is at a book not chosen";
}

function decide(job: Job, decision: DmDecision["decision"], reason?: string) {
  deps?.onDecision({
    kind: job.kind,
    id: job.deliveryId,
    userId: job.sub.userId,
    discordId: job.sub.discordId,
    displayName: job.sub.displayName,
    decision,
    ...(reason ? { reason } : {}),
    ...(job.stake ? { stake: job.stake } : {}),
  });
}

function enqueue(job: Job): void {
  if (queue.length >= MAX_QUEUE) {
    decide(job, "failed", "dm queue full");
    return;
  }
  queue.push(job);
  decide(job, "queued");
  if (!draining) void drain();
}

async function deliver(job: Job): Promise<void> {
  if (!deps) return;
  if (isUndeliverable(job.sub.discordId)) {
    decide(job, "skip", "cannot be DMed, retried later");
    return;
  }
  let recorded: DeliveryResult;
  try {
    recorded = await deps.recordDelivery(job.sub.userId, job.deliveryId);
  } catch (err) {
    decide(job, "failed", `recording the delivery failed: ${String(err)}`);
    return;
  }
  if (recorded === "duplicate") {
    decide(job, "duplicate", "already delivered");
    return;
  }
  try {
    await deps.send(job.sub.discordId, job.message);
    decide(job, "sent");
  } catch (err) {
    const code = discordCode(err);
    if (code !== undefined && CANNOT_DM.has(code)) {
      undeliverable.set(job.sub.discordId, Date.now() + UNDELIVERABLE_RETRY_MS);
      if (!loggedUndeliverable.has(job.sub.discordId)) {
        loggedUndeliverable.add(job.sub.discordId);
        logger.warn("User cannot be DMed, pausing their alerts", {
          userId: job.sub.userId,
          discordId: job.sub.discordId,
          code,
        });
      }
      decide(job, "undeliverable", `discord code ${code}`);
      return;
    }
    decide(job, "failed", String(err));
  }
}

// One at a time with a gap, so a burst of alerts never trips Discord's global limit or spam checks.
async function drain(): Promise<void> {
  draining = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      await deliver(job);
      if (queue.length) await sleep(SPACING_MS);
    }
  } finally {
    draining = false;
  }
}

function skip(kind: Job["kind"], id: string, sub: Subscriber, reason: string) {
  deps?.onDecision({
    kind,
    id,
    userId: sub.userId,
    discordId: sub.discordId,
    displayName: sub.displayName,
    decision: "skip",
    reason,
  });
}

export function dmAlert(entry: LedgerEntry, live: ValueBet | null | undefined) {
  if (!deps) return;
  for (const sub of subscribers) {
    const reason = alertSkipReason(sub, entry);
    if (reason) {
      skip("alert", entry.id, sub, reason);
      continue;
    }
    const staking = stakingOf(sub);
    const stake = staking
      ? money(
          kelly(
            Number(entry.alert_odds),
            1 / Number(entry.alert_fair_odds),
            staking.kellyFraction,
          ) * staking.bankroll,
          staking.currency,
        )
      : "no bankroll set, per 1000";
    enqueue({
      kind: "alert",
      deliveryId: entry.id,
      sub,
      message: alertMessage(entry, live, staking),
      stake,
    });
  }
}

export function dmArb(arb: Arb) {
  if (!deps) return;
  const id = `arb:${arb.id}`;
  for (const sub of subscribers) {
    const reason = arbSkipReason(sub, arb);
    if (reason) {
      skip("arb", id, sub, reason);
      continue;
    }
    enqueue({ kind: "arb", deliveryId: id, sub, message: arbMessage(arb) });
  }
}
