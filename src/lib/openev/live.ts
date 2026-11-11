import { logger } from "@/lib/logger";
import { type Arb, type LedgerEntry, OPENEV_WS_URL } from "@/lib/openev/client";
import { isRecord } from "@/lib/state";

// The parts of the API's `Event` union the feed reads.
export type FeedEvent =
  | { type: "ledger_added"; entry: LedgerEntry }
  | { type: "arbs_snapshot"; arbs: Arb[] }
  | { type: "arb_added" | "arb_updated"; arb: Arb }
  | { type: "arb_removed"; id: string };

interface LiveHandlers {
  // Runs after every (re)connect once the topics are subscribed; the place to catch up.
  onReady: () => void;
  onEvent: (event: FeedEvent) => void;
}

const PING_MS = 20_000;
// The API pings every 20 s, so a minute of silence is a dead socket.
const SILENCE_MS = 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

const CONFIDENCES = ["high", "medium", "low", "check"];

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number";

function isLedgerEntry(v: unknown): v is LedgerEntry {
  return (
    isRecord(v) &&
    str(v.id) &&
    str(v.alerted_at) &&
    str(v.alert_odds) &&
    str(v.alert_fair_odds) &&
    num(v.alert_ev) &&
    str(v.book) &&
    CONFIDENCES.some((c) => c === v.confidence) &&
    str(v.status) &&
    str(v.sharp_key) &&
    str(v.game_id) &&
    str(v.home) &&
    str(v.away) &&
    str(v.league) &&
    str(v.market) &&
    str(v.period) &&
    str(v.side) &&
    str(v.starts_at)
  );
}

function isArb(v: unknown): v is Arb {
  return (
    isRecord(v) &&
    str(v.id) &&
    str(v.game_id) &&
    num(v.profit) &&
    typeof v.check === "boolean" &&
    str(v.home) &&
    str(v.away) &&
    str(v.league) &&
    str(v.market) &&
    str(v.period) &&
    str(v.starts_at) &&
    Array.isArray(v.legs) &&
    v.legs.every(
      (l) =>
        isRecord(l) &&
        str(l.book) &&
        str(l.odds) &&
        str(l.side) &&
        num(l.stake_share),
    )
  );
}

// Checks the fields the bot reads, so a protocol change fails here and not inside an embed.
function feedEvent(v: unknown): FeedEvent | null {
  if (!isRecord(v) || v.v !== 1) return null;
  switch (v.type) {
    case "ledger_added":
      return isLedgerEntry(v.entry)
        ? { type: "ledger_added", entry: v.entry }
        : null;
    case "arbs_snapshot":
      return Array.isArray(v.arbs) && v.arbs.every(isArb)
        ? { type: "arbs_snapshot", arbs: v.arbs }
        : null;
    case "arb_added":
      return isArb(v.arb) ? { type: "arb_added", arb: v.arb } : null;
    case "arb_updated":
      return isArb(v.arb) ? { type: "arb_updated", arb: v.arb } : null;
    case "arb_removed":
      return str(v.id) ? { type: "arb_removed", id: v.id } : null;
    default:
      return null;
  }
}

function parse(data: unknown): unknown {
  if (!str(data)) return null;
  try {
    const value: unknown = JSON.parse(data);
    return value;
  } catch {
    return null;
  }
}

// Keeps one socket to /v1/ws open forever: ledger and arbs topics, reconnect with exponential backoff.
export function connectLive(handlers: LiveHandlers): void {
  let backoff = BACKOFF_MIN_MS;

  const connect = () => {
    let lastFrame = Date.now();
    let ready = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(OPENEV_WS_URL);
    } catch (err) {
      logger.warn("Live feed connect failed", { error: String(err) });
      retry();
      return;
    }

    const timer = setInterval(() => {
      if (Date.now() - lastFrame > SILENCE_MS) {
        logger.warn("Live feed silent, reconnecting");
        ws.close();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
    }, PING_MS);

    ws.addEventListener("message", (msg) => {
      lastFrame = Date.now();
      const value = parse(msg.data);
      if (isRecord(value) && value.type === "welcome") {
        for (const topic of ["ledger", "arbs"]) {
          ws.send(JSON.stringify({ type: "subscribe", topic }));
        }
        ready = true;
        backoff = BACKOFF_MIN_MS;
        logger.info("Live feed connected", { url: OPENEV_WS_URL });
        handlers.onReady();
        return;
      }
      if (isRecord(value) && value.type === "error") {
        logger.warn("Live feed error", { message: value.message });
        return;
      }
      const event = feedEvent(value);
      if (event) handlers.onEvent(event);
      else if (
        isRecord(value) &&
        (value.type === "ledger_added" || String(value.type).startsWith("arb"))
      ) {
        logger.warn("Live feed message failed validation", {
          type: value.type,
        });
      }
    });

    ws.addEventListener("close", (ev) => {
      clearInterval(timer);
      logger.warn("Live feed closed", {
        code: ev.code,
        reason: ev.reason,
        wasReady: ready,
        retryInMs: backoff,
      });
      retry();
    });

    // A close event always follows, so the retry happens there.
    ws.addEventListener("error", () => {});
  };

  const retry = () => {
    const jitter = Math.random() * backoff * 0.2;
    setTimeout(connect, backoff + jitter);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  connect();
}
