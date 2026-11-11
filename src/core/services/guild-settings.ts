import type { Arb, LedgerEntry } from "@/lib/openev/client";
import { dataFile, isRecord, readJson, writeJson } from "@/lib/state";
import {
  type AlertConfidence,
  LEDGER_MIN_EV,
  isAlertConfidence,
  meetsConfidence,
} from "@/shared/config/openev";

const FILE = dataFile("openev-guilds.json");

export interface GuildAlertSettings {
  // Null keeps the guild out of the feed.
  channelId: string | null;
  // Fractions, like the API: 0.03 is +3%.
  minEv: number;
  // Empty means every book.
  books: string[];
  minConfidence: AlertConfidence;
  arbs: boolean;
  // Null posts arbs to the alert channel.
  arbsChannelId: string | null;
  minArbProfit: number;
}

export const DEFAULT_SETTINGS: GuildAlertSettings = {
  channelId: null,
  minEv: LEDGER_MIN_EV,
  books: [],
  minConfidence: "low",
  arbs: false,
  arbsChannelId: null,
  minArbProfit: 0.01,
};

const settings = new Map<string, GuildAlertSettings>();

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSettings(value: unknown): GuildAlertSettings | null {
  if (!isRecord(value)) return null;
  return {
    channelId: str(value.channelId),
    minEv: num(value.minEv, DEFAULT_SETTINGS.minEv),
    books: Array.isArray(value.books)
      ? value.books.filter((b): b is string => typeof b === "string")
      : [],
    minConfidence: isAlertConfidence(value.minConfidence)
      ? value.minConfidence
      : DEFAULT_SETTINGS.minConfidence,
    arbs: value.arbs === true,
    arbsChannelId: str(value.arbsChannelId),
    minArbProfit: num(value.minArbProfit, DEFAULT_SETTINGS.minArbProfit),
  };
}

export async function loadGuildSettings(): Promise<void> {
  const parsed = await readJson(FILE);
  if (!isRecord(parsed)) return;
  for (const [guildId, value] of Object.entries(parsed)) {
    const s = parseSettings(value);
    if (s) settings.set(guildId, s);
  }
}

export function guildSettings(guildId: string): GuildAlertSettings {
  return settings.get(guildId) ?? DEFAULT_SETTINGS;
}

export function allGuildSettings(): [string, GuildAlertSettings][] {
  return [...settings.entries()];
}

export async function updateGuildSettings(
  guildId: string,
  patch: Partial<GuildAlertSettings>,
): Promise<GuildAlertSettings> {
  const next = { ...guildSettings(guildId), ...patch };
  settings.set(guildId, next);
  await writeJson(FILE, Object.fromEntries(settings));
  return next;
}

export function wantsAlert(s: GuildAlertSettings, e: LedgerEntry): boolean {
  return (
    e.alert_ev >= s.minEv &&
    (s.books.length === 0 || s.books.includes(e.book)) &&
    meetsConfidence(e.confidence, s.minConfidence)
  );
}

// Every leg has to be at one of the guild's books or the arb cannot be placed.
export function wantsArb(s: GuildAlertSettings, arb: Arb): boolean {
  return (
    s.arbs &&
    !arb.check &&
    arb.profit >= s.minArbProfit &&
    (s.books.length === 0 || arb.legs.every((l) => s.books.includes(l.book)))
  );
}
