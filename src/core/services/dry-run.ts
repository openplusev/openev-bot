import { type AlertMessage, alertMessage } from "@/core/embeds/alert.embed";
import { arbMessage } from "@/core/embeds/arb.embed";
import { liveBet, runAlertsFeed } from "@/core/services/alerts.feed";
import { dmAlert, startDmAlerts } from "@/core/services/dm-alerts";
import {
  DEFAULT_SETTINGS,
  type GuildAlertSettings,
  wantsArb,
} from "@/core/services/guild-settings";
import { logger } from "@/lib/logger";
import { fetchArbs, fetchLedger } from "@/lib/openev/client";
import {
  INTERNAL_TOKEN,
  type Subscriber,
  fetchSubscribers,
  parseSubscriber,
} from "@/lib/openev/internal";

// The internal API's JSON shape, so the mocks go through the same parser as real rows.
const MOCK_ROWS: unknown[] = [
  {
    user_id: "mock-user-1",
    discord_id: "100000000000000001",
    display_name: "Ana (all alerts, EUR)",
    prefs: {
      enabled: true,
      min_ev: 0.02,
      books: [],
      min_confidence: "low",
      arbs: true,
      min_arb_profit: 0.005,
      channels: { discord_dm: true, telegram: false },
    },
    bankroll: 1500,
    kelly_fraction: 0.25,
    currency: "EUR",
  },
  {
    user_id: "mock-user-2",
    discord_id: "100000000000000002",
    display_name: "Ben (Coral only, GBP)",
    prefs: {
      enabled: true,
      min_ev: 0.02,
      books: ["coral"],
      min_confidence: "low",
      arbs: false,
      min_arb_profit: 0.01,
      channels: { discord_dm: true, telegram: true },
    },
    bankroll: 400,
    kelly_fraction: 0.5,
    currency: "GBP",
  },
  {
    user_id: "mock-user-3",
    discord_id: "100000000000000003",
    display_name: "Cara (Telegram only)",
    prefs: {
      enabled: true,
      min_ev: 0.02,
      books: [],
      min_confidence: "low",
      arbs: true,
      min_arb_profit: 0.01,
      channels: { discord_dm: false, telegram: true },
    },
    bankroll: 2000,
    kelly_fraction: 0.25,
    currency: "USD",
  },
  {
    user_id: "mock-user-4",
    discord_id: "100000000000000004",
    display_name: "Dan (DMs closed, USD)",
    prefs: {
      enabled: true,
      min_ev: 0.02,
      books: [],
      min_confidence: "low",
      arbs: false,
      min_arb_profit: 0.01,
      channels: { discord_dm: true, telegram: false },
    },
    bankroll: 10000,
    kelly_fraction: 1,
    currency: "USD",
  },
  {
    user_id: "mock-user-5",
    discord_id: "100000000000000005",
    display_name: "Eve (high confidence only)",
    prefs: {
      enabled: true,
      min_ev: 0.02,
      books: [],
      min_confidence: "high",
      arbs: false,
      min_arb_profit: 0.01,
      channels: { discord_dm: true, telegram: false },
    },
    bankroll: null,
    kelly_fraction: 0.25,
    currency: "EUR",
  },
];

const CLOSED_DMS = new Set(["100000000000000004"]);

function mockSubscribers(): Subscriber[] {
  return MOCK_ROWS.map(parseSubscriber).filter(
    (s): s is Subscriber => s !== null,
  );
}

function print(kind: string, body: Record<string, unknown>): void {
  console.log(JSON.stringify({ dryRun: kind, ...body }, null, 2));
}

function messageJson(message: AlertMessage | string): Record<string, unknown> {
  return typeof message === "string"
    ? { content: message }
    : {
        embeds: message.embeds.map((e) => e.toJSON()),
        components: message.components.map((c) => c.toJSON()),
      };
}

// The real endpoint when INTERNAL_TOKEN is set and it answers, mocked subscribers otherwise.
async function dryRunSubscribers(): Promise<Subscriber[]> {
  if (INTERNAL_TOKEN) {
    try {
      return await fetchSubscribers();
    } catch (err) {
      logger.info("Subscribers endpoint unavailable, using mocks", {
        error: String(err),
      });
    }
  }
  return mockSubscribers();
}

// DRY_RUN: no Discord login, no DATA_DIR writes, deliveries recorded in memory only.
export async function runDryRun(samples: number): Promise<void> {
  const delivered = new Set<string>();
  await startDmAlerts({
    fetchSubscribers: dryRunSubscribers,
    recordDelivery: async (userId, ledgerId) => {
      const key = `${userId}:${ledgerId}`;
      if (delivered.has(key)) return "duplicate";
      delivered.add(key);
      return "created";
    },
    send: async (discordId, message) => {
      if (CLOSED_DMS.has(discordId)) {
        throw Object.assign(new Error("Cannot send messages to this user"), {
          code: 50007,
        });
      }
      print("dm", { to: discordId, ...messageJson(message) });
    },
    onDecision: (d) => print("dm decision", { ...d }),
  });

  const settings: GuildAlertSettings = { ...DEFAULT_SETTINGS, arbs: true };
  for (const entry of (await fetchLedger(samples)).slice(0, samples)) {
    const live = await liveBet(entry.id);
    print("sample channel alert", messageJson(alertMessage(entry, live)));
    dmAlert(entry, live);
  }
  const arb = (await fetchArbs(settings.minArbProfit)).find((a) =>
    wantsArb(settings, a),
  );
  if (arb) print("sample arb", messageJson(arbMessage(arb)));

  await runAlertsFeed({
    persist: false,
    targets: () => [
      {
        name: "dry run",
        settings,
        sendAlert: async (m) => print("channel alert", messageJson(m)),
        sendArb: async (m) => print("channel arb", messageJson(m)),
        sendText: async (m) => print("channel text", messageJson(m)),
      },
    ],
  });
}
