import { OPENEV_API_URL } from "@/lib/openev/client";
import { isRecord } from "@/lib/state";
import {
  type AlertConfidence,
  isAlertConfidence,
} from "@/shared/config/openev";

// Not in the public OpenAPI spec, so the shape is checked here at runtime.
export interface AlertPrefs {
  enabled: boolean;
  // Fractions, like the API: 0.03 is +3%.
  minEv: number;
  // Empty means every book.
  books: string[];
  minConfidence: AlertConfidence;
  arbs: boolean;
  minArbProfit: number;
  discordDm: boolean;
}

export interface Subscriber {
  // Sent back exactly as the API gave it, a UUID string or a number.
  userId: string | number;
  discordId: string;
  displayName: string;
  prefs: AlertPrefs;
  // Null when the user has not set a bankroll.
  bankroll: number | null;
  kellyFraction: number;
  currency: string;
}

export type DeliveryResult = "created" | "duplicate";

const TIMEOUT_MS = 10_000;

export const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN?.trim() ?? "";

export class InternalApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`OpenEV ${path} answered ${status}`);
  }
}

function headers(): Record<string, string> {
  return {
    "X-Internal-Token": INTERNAL_TOKEN,
    "Content-Type": "application/json",
  };
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function idString(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function parsePrefs(v: unknown): AlertPrefs | null {
  if (!isRecord(v)) return null;
  const channels = isRecord(v.channels) ? v.channels : {};
  return {
    enabled: v.enabled === true,
    minEv: finite(v.min_ev) ?? 0,
    books: Array.isArray(v.books)
      ? v.books.filter((b): b is string => typeof b === "string")
      : [],
    minConfidence: isAlertConfidence(v.min_confidence)
      ? v.min_confidence
      : "low",
    arbs: v.arbs === true,
    minArbProfit: finite(v.min_arb_profit) ?? 0.01,
    discordDm: channels.discord_dm === true,
  };
}

export function parseSubscriber(v: unknown): Subscriber | null {
  if (!isRecord(v)) return null;
  const rawId = v.user_id;
  const userId =
    typeof rawId === "string" && rawId
      ? rawId
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? rawId
        : null;
  const discordId = idString(v.discord_id);
  const prefs = parsePrefs(v.prefs);
  if (!userId || !discordId || !/^\d{15,22}$/.test(discordId) || !prefs) {
    return null;
  }
  const bankroll = finite(v.bankroll);
  const kelly = finite(v.kelly_fraction);
  return {
    userId,
    discordId,
    displayName:
      typeof v.display_name === "string" && v.display_name
        ? v.display_name
        : discordId,
    prefs,
    bankroll: bankroll !== null && bankroll > 0 ? bankroll : null,
    kellyFraction: kelly !== null && kelly > 0 && kelly <= 1 ? kelly : 0.25,
    currency:
      typeof v.currency === "string" && /^[A-Za-z]{3}$/.test(v.currency)
        ? v.currency.toUpperCase()
        : "USD",
  };
}

export async function fetchSubscribers(): Promise<Subscriber[]> {
  const path = "/v1/internal/alert-subscribers";
  const res = await fetch(`${OPENEV_API_URL}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new InternalApiError(path, res.status);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new InternalApiError(path, res.status);
  return body.map(parseSubscriber).filter((s): s is Subscriber => s !== null);
}

// Unique per user and ledger id: 409 means another run already sent it.
export async function recordDelivery(
  userId: string | number,
  ledgerId: string,
): Promise<DeliveryResult> {
  const path = "/v1/internal/alert-deliveries";
  const res = await fetch(`${OPENEV_API_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      user_id: userId,
      ledger_id: ledgerId,
      channel: "dm",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 409) return "duplicate";
  if (!res.ok) throw new InternalApiError(path, res.status);
  return "created";
}
