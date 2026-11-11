# openev-bot

Discord bot for OpenCapper, the verified sports picks platform. Analysts lock picks with
`/pick`, the OpenCapper API captures the odds and grades them, and `/recap` posts the
server's honest record. The bot keeps no database: every read and write goes through the API.

## Commands

| Command                                    | What it does                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `/pick sport event market selection units` | Locks a pick at the odds the API captures. `event` autocompletes upcoming games.  |
| `/recap [days]`                            | Record, units and ROI per capper in this server, sorted by units. Default 7 days. |
| `/record [user]`                           | One capper's live record, by Discord id. Default yourself.                        |
| `/leaderboard [sport] [period]`            | Top 10 cappers by ROI (30d, 90d, 1y, all). Default all sports, 30 days.           |
| `/verify pick [user]`                      | Proof page link: a pick id (`123`), or a capper's pick number (`#9`) with `user`. |
| `/capper [user] [name]`                    | Is this capper real? Verified record, or a warning that there is none.            |

`/pick` details:

- `event` matches team words in any order, prefixes, initials (`KC`, `NYG`) and one or two typos
  per word. Text typed without choosing a suggestion resolves to the single best match, or the
  bot lists the candidates. Autocomplete waits at most 2 seconds for the API, then serves the
  last list it has or an "unavailable" row.
- `units` go from 0.5 to 5 in steps of 0.5, the API's shared rule (`UNITS` in
  `src/shared/config/units.ts`). Checked before any API call.
- One pick attempt per user every 15 seconds, before the API's own per user limit.
- Every check that needs no odds (units, cooldown, event, started) answers privately before
  the reply is deferred. An API error after that replaces the public reply and deletes itself
  after a minute.

## Results feed

Every 5 minutes the bot asks the API for picks settled in each server since the last post and
posts one result embed per pick (win, loss, push or void, units won or lost, captured vs
closing odds and CLV when known) into the first text channel whose name contains
`RESULTS_CHANNEL` (default `results`), at most 50 per tick. Servers without such a channel are
skipped. The watermark per server is `{ since, seen }`: grading stamps a whole batch with one
time, so it keeps the ids already posted at `since` and asks the API from 1 ms earlier. It lives
in memory and in `DATA_DIR/results-watermarks.json` (default `/app/data`, a named docker
volume), so restarts do not repost. A server is first polled from
the moment the bot sees its results channel, never backfilled. A 404 from the endpoint is
treated as not deployed yet and skipped quietly.

## OpenEV alerts

The bot also posts OpenEV value bet alerts. The source of truth is the OpenEV ledger
(`GET /v1/ledger`, every value bet from +2% EV that is not a confidence check), so the Discord
feed always matches the public proof page. Every 15 seconds the bot reads the newest 500 ledger
rows and posts each new one once to every server whose filters it passes, at most 20 per server
per tick (a larger burst ends with one line pointing at the proof page). Arbs (`GET /v1/arbs`,
stale `check` arbs left out) are posted once per appearance; an arb gone for 6 hours counts as
new again. The first poll after a fresh start marks the current ledger and arbs as seen instead
of posting them.

Types come from the API's OpenAPI spec: `bun run api:types` (reads
`OPENEV_API_URL/v1/openapi.json`, writes `src/lib/openev/schema.d.ts`); calls go through
`openapi-fetch` in `src/lib/openev/client.ts`, like the web app.

| Command                                       | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `/alerts channel channel`                     | Post alerts in this channel. Checks the bot can post embeds there.   |
| `/alerts stop`                                | Stop posting alerts and arbs; filters are kept.                      |
| `/alerts min_ev percent`                      | Minimum EV in percent (2 to 50, default 2, the ledger floor).        |
| `/alerts books books`                         | Comma list of book codes (autocompleted from `/v1/books`), or `all`. |
| `/alerts confidence level`                    | Minimum confidence: low (all), medium or high.                       |
| `/alerts arbs enabled [channel] [min_profit]` | Arbs on or off, own channel (default the alert channel), default 1%. |
| `/alerts status`                              | This server's settings, only to you.                                 |
| `/alerts test`                                | The newest alert your filters let through, only to you, not posted.  |

All `/alerts` commands need Manage Server by default (server owners can change that under
Integrations). An arb passes the books filter only if every leg is at one of the chosen books.

The alert embed shows selection and book, alert odds against the fair odds, EV and safe EV (the
least favourable devig, read from `GET /v1/value-bets/{id}` when the price is still the alert
price), confidence, a quarter Kelly stake per 1000 bankroll, kickoff in the reader's time zone,
and link buttons to `/value-bets/{id}` and `/games/{id}` on `OPENEV_WEBSITE_URL`. When the bet
is gone by the time it posts, the odds field says so.

Settings live in `DATA_DIR/openev-guilds.json`, the ledger watermark and seen arbs in
`DATA_DIR/openev-alerts.json`.

Dry run without Discord: `DRY_RUN=1 OPENEV_API_URL=http://127.0.0.1:8085 bun start` prints
`DRY_RUN_SAMPLES` (default 3) recent alerts and one arb as embed JSON, then every new alert as
it lands, for one server with default filters and arbs on. It writes no state.

## Run

```bash
cp .env.example .env   # fill DISCORD_BOT_TOKEN and BOT_API_TOKEN
bun install
bun dev
```

Set `DEV_GUILD_ID` to register slash commands on one server instantly instead of globally.
Set `DATA_DIR=./data` locally; the default `/app/data` only exists in the container.

## API contract

Base `OPENCAPPER_API_URL` (default `https://opencapper.coding-global.com/api`). Every request
sends `Authorization: Bearer <BOT_API_TOKEN>`. Errors return a non 2xx status with
`{ "error": "message" }`; the message is shown to the user as is. Types live in `src/lib/api.ts`.
`POST /picks` answers 429 once the API's daily odds budget for user picks is spent and 503 while
it keeps its remaining Odds API credits for grading; both carry a readable `error`.

| Method | Path                                   | Response              |
| ------ | -------------------------------------- | --------------------- |
| GET    | `/events?sport=<sportKey>`             | `ApiEvent[]`          |
| GET    | `/events/:sportKey/:eventId/shape`     | `ApiMarketOdds[]`     |
| POST   | `/picks` (body `CreatePickRequest`)    | `ApiPick`             |
| GET    | `/recap?guildId=&from=&to=` (ISO 8601) | `RecapResponse`       |
| GET    | `/picks/settled?guildId=&since=` (ISO) | `ApiSettledPick[]`    |
| GET    | `/leaderboard?sport=&period=&sort=roi` | `LeaderboardResponse` |
| GET    | `/check?q=<query>`                     | `CapperCheck`         |
| GET    | `/check/discord/:discordId`            | `CapperCheck`         |

`market` is one of `h2h`, `spreads`, `totals` (every sport) or `method`, `period_win`,
`distance` (fight sports). Selections for the last three are fixed labels such as
`Seok Hyun Ko by Submission in Round 1` or `Goes the Distance`; `/events/:sportKey/:eventId/shape`
lists them with American odds and costs no Odds API credits, so `/pick` autocompletes from it.

`ApiEvent` and `ApiPick` carry optional `homeImage`, `awayImage` (absolute image URLs) and
`homeCountry`, `awayCountry` (short codes such as `USA`). The pick and result embeds use the
picked side's image as thumbnail (home when the selection names no side) and show countries
next to the names.

`/picks/settled` returns picks of that guild whose `settledAt` is strictly after `since`,
oldest first, result not `pending`, disqualified picks (locked at or after the real start)
left out. `ApiPick` may carry `disqualified: { actualStart }` (ISO); the feed skips such a pick
if one ever arrives. `ApiSettledPick` is `ApiPick` plus `settledAt` (ISO),
`closingOdds` (American, optional) and `clv` (fraction like `roi`, optional). Odds are
American; units won on a win are `units * odds / 100` (plus odds) or `units * 100 / |odds|`.

`/leaderboard`: `sport` is a sport group (`americanfootball`, `basketball`, `baseball`,
`icehockey`, `soccer`, `tennis`, `golf`, `mma`, `boxing`, `cricket`, `aussierules`, `rugby`,
the API's `SPORT_GROUPS`), not an Odds API sport key, and omitted for all sports, `period` is `30d`, `90d`,
`1y` or `all`. Response `{ rows, minGraded, total }`, rows `{ rank, username, picks, graded,
wins, losses, pushes, units, unitsRisked, roi, sports }` sorted by the API. A 404 shows
"The leaderboard is coming soon."

`/capper`: `user` resolves by Discord id only (`/check/discord/:discordId`), never by name, since
a same named account elsewhere is exactly what impersonators use. `name` goes to `/check?q=`,
the same lookup as the web page `/check`: OpenCapper username, Discord username or id,
Telegram username, Polymarket wallet or name, Reddit name, or a pasted profile link. Response
`{ query, matches }`, at most 5 matches, best first. A match carries `username`, `avatarUrl`,
`matchedBy`, `status` (`member`, `imported`, `claimed`), `platform`, `claimedBy`, `live` (a
`CheckRecord` plus `pending`), `history` (on chain, or null), `total` (live plus history) and
`lastPickAt` (ISO or null). `CheckRecord` is `{ graded, wins, losses, pushes, units,
unitsRisked, roi }`. Hidden profiles never match. No match replies "No verified OpenCapper
record for @user" with the warning and a link to the web check. The endpoint is public and rate
limited per IP; requests with the bot token skip the limit.

`/record` resolves by Discord id (`/check/discord/:discordId`) and shows the first match's
`live` record. No match, or a 404, replies a neutral "No OpenCapper record" without the
verified footer.

`ApiPick.id` is the global pick id, the one `WEBSITE_URL/en/verify?pick=<id>` reads; every
embed links with it and shows it next to the per capper number (`#12 (id 14)`). `/verify 14`
needs no API call. `/verify #9 [user]` looks the capper up by Discord id (default the caller)
and links `/en/verify?user=<username>&seq=9`.

## Deploy

Komodo stack on the Netcup box: Komodo clones this repo and runs `docker compose build` and
`up`. Runtime env comes from the stack's `.env`. The Dockerfile builds a single Bun binary on
distroless for amd64 or arm64.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
