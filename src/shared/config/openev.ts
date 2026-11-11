import type { Confidence } from "@/lib/openev/client";

export const OPENEV_WEBSITE_URL = (
  process.env.OPENEV_WEBSITE_URL?.trim() || "https://openev.coding-global.com"
).replace(/\/+$/, "");

export function betUrl(id: string): string {
  return `${OPENEV_WEBSITE_URL}/value-bets/${encodeURIComponent(id)}`;
}

export function gameUrl(id: string): string {
  return `${OPENEV_WEBSITE_URL}/games/${encodeURIComponent(id)}`;
}

export const ARBS_URL = `${OPENEV_WEBSITE_URL}/arbs`;
export const PROOF_URL = `${OPENEV_WEBSITE_URL}/proof`;
export const SETTINGS_URL = `${OPENEV_WEBSITE_URL}/en/settings`;

// The ledger records value bets from +2% EV, so a lower guild minimum changes nothing.
export const LEDGER_MIN_EV = 0.02;

// `check` is never an alert: the ledger leaves those bets out.
export const ALERT_CONFIDENCES = [
  { name: "Low (all alerts)", value: "low" },
  { name: "Medium", value: "medium" },
  { name: "High", value: "high" },
] as const;

export type AlertConfidence = (typeof ALERT_CONFIDENCES)[number]["value"];

export function isAlertConfidence(value: unknown): value is AlertConfidence {
  return ALERT_CONFIDENCES.some((c) => c.value === value);
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  check: -1,
  low: 0,
  medium: 1,
  high: 2,
};

export function meetsConfidence(
  confidence: Confidence,
  min: AlertConfidence,
): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[min];
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  check: "Check",
};

export const CONFIDENCE_COLOR: Record<Confidence, number> = {
  high: 0x57f287,
  medium: 0xfee75c,
  low: 0x99aab5,
  check: 0xed4245,
};

export const ARB_COLOR = 0x5865f2;

// Mirrors BOOKS in the web app (openev src/lib/format.ts).
const BOOKS: Record<string, string> = {
  ubuk: "Unibet UK",
  gruk: "Grosvenor",
  betuk: "BetUK",
  betmgmuk: "BetMGM UK",
  quinnbetuk: "QuinnBet",
  virginbetuk: "Virgin Bet",
  ladbrokes: "Ladbrokes",
  coral: "Coral",
  paddypower: "Paddy Power",
  betfairsb: "Betfair Sportsbook",
  betfair_ex: "Betfair Exchange",
  smarkets: "Smarkets",
  williamhill: "William Hill",
  skybet: "Sky Bet",
  betway: "Betway",
  betvictor: "BetVictor",
  "888sport": "888sport",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  kalshi: "Kalshi",
  polymarket: "Polymarket",
  matchbook: "Matchbook",
  betdaq: "Betdaq",
  cloudbet: "Cloudbet",
  betsson: "Betsson",
  betsafe: "Betsafe",
  nordicbet: "NordicBet",
  ub: "Unibet",
  ubnl: "Unibet NL",
  ubse: "Unibet SE",
  ubdk: "Unibet DK",
  ubca: "Unibet CA",
  paf: "Paf",
  pafes: "Paf ES",
  leose: "LeoVegas SE",
  leoes: "LeoVegas ES",
  expektse: "Expekt",
  betmgmse: "BetMGM SE",
  betmgmnl: "BetMGM NL",
  svenskaspel: "Svenska Spel",
  rsiusil: "BetRivers IL",
  rsiuspa: "BetRivers PA",
  parxuspa: "Parx",
  betssonco: "Betsson CO",
  pinnacle: "Pinnacle",
};

export function bookName(code: string): string {
  return BOOKS[code] ?? code;
}
