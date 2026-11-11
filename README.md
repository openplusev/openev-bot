# openev-bot

Discord bot for OpenEV. It posts value bet alerts the moment the OpenEV ledger records them,
to server channels with per server filters and to users by DM with their own filters and
stake sizing. Arbs are optional for both. The bot keeps no database: alerts come from the
OpenEV API, server settings and the feed watermark live in small JSON files in `DATA_DIR`.

## Commands

| Command                                       | Who           | What it does                                                         |
| --------------------------------------------- | ------------- | -------------------------------------------------------------------- |
| `/help`                                       | everyone      | What the bot does and every command, only to you.                    |
| `/alerts me`                                  | everyone      | Your personal DM alert status and a link to the settings page.       |
| `/alerts channel channel`                     | Manage Server | Post alerts in this channel. Checks the bot can post embeds there.   |
| `/alerts stop`                                | Manage Server | Stop posting alerts and arbs; filters are kept.                      |
| `/alerts min_ev percent`                      | Manage Server | Minimum EV in percent (2 to 50, default 2, the ledger floor).        |
| `/alerts books books`                         | Manage Server | Comma list of book codes (autocompleted from `/v1/books`), or `all`. |
| `/alerts confidence level`                    | Manage Server | Minimum confidence: low (all), medium or high.                       |
| `/alerts arbs enabled [channel] [min_profit]` | Manage Server | Arbs on or off, own channel (default the alert channel), default 1%. |
| `/alerts status`                              | Manage Server | This server's settings, only to you.                                 |
| `/alerts test`                                | Manage Server | The newest alert your filters let through, only to you, not posted.  |

`/help` and `/alerts` also work in DMs with the bot. Server subcommands check Manage Server at
run time instead of through Discord's default permissions, which would hide `/alerts me` from
members. An arb passes the books filter only if every leg is at one of the chosen books.

## Live feed

The source of truth is the OpenEV ledger (every value bet from +2% EV that is not a confidence
check), so Discord matches the public proof page. The bot holds one WebSocket to the API's
`/v1/ws` (protocol v1) and subscribes to `ledger` and `arbs`:

- `ledger_added` events are collected for half a second (one snapshot sends them back to back)
  and posted as one batch, at most 20 per server; a larger burst ends with one line pointing at
  the proof page.
- On every connect and reconnect the bot first reads `GET /v1/ledger` (newest 500) and posts
  what lies past its watermark, so nothing is lost while the socket was down. The watermark is
  `{ since, seen }` (one snapshot stamps all its alerts with one `alerted_at`) and dedupes catch
  up and live events. The very first start without a state file posts nothing.
- `arbs_snapshot` (sent on every subscribe) and `arb_added` post arbs not listed in the last 6
  hours; `arb_updated` and `arb_removed` only refresh that time. Stale `check` arbs are left out.
- The bot pings every 20 s and reconnects after 60 s of silence or any close, with exponential
  backoff from 1 s to 60 s plus jitter.

Transport: in production the bot reaches the API as `http://openev-api:8080` on the shared
`proxy` network, so the WebSocket is `ws://openev-api:8080/v1/ws` directly, past Traefik and its
per IP limits. The Valkey channel `openev:events` carries the same messages, but Valkey lives
on the API stack's private `openev` network next to Postgres and has no password; joining it
would couple this stack to the API's compose project name and expose those services, and the
bot would have to parse and drop every `game:{id}` price event. The WebSocket subscribes to just
the two topics.

## Personal DM alerts

Users configure alerts on the web settings page (`OPENEV_WEBSITE_URL/en/settings`). The bot
reads them from the API's internal endpoints with `X-Internal-Token: INTERNAL_TOKEN`:

| Method | Path                             | Body or response                                                                                                                                                                           |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/v1/internal/alert-subscribers` | `[{ user_id, discord_id, display_name, prefs: { enabled, min_ev, books, min_confidence, arbs, min_arb_profit, channels: { discord_dm, telegram } }, bankroll, kelly_fraction, currency }]` |
| POST   | `/v1/internal/alert-deliveries`  | `{ user_id, ledger_id, channel: "dm" }`, unique per user and ledger id, 409 when already sent                                                                                              |

- Subscribers are cached and refreshed every 60 s; a failed refresh keeps the last list, a 404
  turns DMs off quietly until the endpoint exists.
- On each new ledger alert every subscriber with `enabled`, `channels.discord_dm`, EV at least
  `min_ev`, the book in `books` (empty means all) and confidence at least `min_confidence` gets
  the channel embed with "Your stake": Kelly of their bankroll at their `kelly_fraction`,
  rounded to a whole amount in their currency (per 1000 when no bankroll is set), plus the Bet
  details and Game buttons.
- Arbs go to subscribers with `arbs` and profit at least `min_arb_profit`. Their delivery key is
  `ledger_id: "arb:<arb id>"`, so the deliveries table must not require a ledger row.
- The delivery is recorded first; the DM is sent only when the API created the record, so a
  restart or a second instance never sends twice.
- DMs leave one at a time, 200 ms apart (Discord allows 50 requests a second globally; opening a
  DM channel counts too), from a queue of at most 1000.
- A user the bot cannot DM (Discord codes 50007, 50278, 10013: DMs closed, no shared server,
  unknown user) is logged once and skipped for 6 hours, not retried on every alert.

## Embeds

The alert embed shows selection and book, alert odds against the fair odds, EV and safe EV (the
least favourable devig, read from `GET /v1/value-bets/{id}` when the price is still the alert
price), confidence, the stake (quarter Kelly per 1000 in channels, the user's own stake in DMs),
kickoff in the reader's time zone, and link buttons to `/value-bets/{id}` and `/games/{id}` on
`OPENEV_WEBSITE_URL`. When the bet is gone by the time it posts, the odds field says so.

## API types

Public endpoints are typed from the API's OpenAPI spec: `bun run api:types` (reads
`OPENEV_API_URL/v1/openapi.json`, writes `src/lib/openev/schema.d.ts`); calls go through
`openapi-fetch` in `src/lib/openev/client.ts`. WebSocket frames are checked at runtime in
`src/lib/openev/live.ts`, the internal endpoints in `src/lib/openev/internal.ts`.

## Run

```bash
cp .env.example .env   # fill DISCORD_BOT_TOKEN and INTERNAL_TOKEN
bun install
bun dev
```

Set `DEV_GUILD_ID` to register slash commands on one server instantly instead of globally.
Set `DATA_DIR=./data` locally; the default `/app/data` only exists in the container.

Dry run without Discord: `DRY_RUN=1 OPENEV_API_URL=http://127.0.0.1:8085 bun start` prints
`DRY_RUN_SAMPLES` (default 3) recent alerts as channel embed JSON, fans each out to the
subscribers (real ones when `INTERNAL_TOKEN` is set and the endpoint answers, five mocked users
otherwise, one of them with closed DMs) printing every decision and DM, then connects to the
live feed and prints whatever arrives. It records deliveries in memory and writes no state.

## Deploy

Komodo stack on the Netcup box: Komodo clones this repo and runs `docker compose build` and
`up`. Runtime env comes from the stack's `.env`. The Dockerfile builds a single Bun binary on
distroless for amd64 or arm64. The compose service joins the external `proxy` network, where
`openev-api` answers.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
