# CLAUDE.md: openev-bot

Product decisions live in `../claude.md`. The API is `../openev-api`, the web app `../openev`.

## Rules

- bun for everything. No tests unless asked.
- No dashes as punctuation (em, en, `--`), no Unicode arrows, curly quotes or ellipsis, no emojis. Applies to code, comments, docs, embeds and commit messages.
- Comments only for a non obvious why, one terse line.
- Never `as` to silence a type. Untyped JSON (WebSocket frames, internal endpoints) goes through runtime guards in `src/lib/openev/live.ts` and `src/lib/openev/internal.ts`.
- No barrel files. No TS enums: union literals derived from `as const` arrays (`ALERT_CONFIDENCES` in `src/shared/config/openev.ts`).
- No database here. State belongs to the API; add an endpoint there instead of storing anything in the bot. The exceptions are JSON files in `DATA_DIR`: guild settings (`openev-guilds.json`) and the alert watermark plus seen arbs (`openev-alerts.json`). Write them only through `src/lib/state.ts`.
- Brand strings come from env (`OPENEV_WEBSITE_URL`). Never hardcode Discord IDs. Alert channels are chosen per guild with `/alerts channel` and stored by id.
- OpenEV public types are generated (`bun run api:types`, `src/lib/openev/schema.d.ts`), never written by hand. Run it after the API changes its spec.
- No Co-Authored-By or AI references in git.

## Traps

- Every file in `src/bot/commands` must be imported in `src/bot/index.ts`. discordx registers by import side effect; `bun run build` (tsup) fails on a missing or stale import.
- `/alerts` has no `defaultMemberPermissions`: Discord permissions are per top level command and would hide `/alerts me` from members. Server subcommands call `managedGuild`, which checks Manage Server.
- Autocomplete must answer within 3 seconds: books load with a 2 second timeout, are cached for 5 minutes, and a failed refresh serves the stale list.
- Global slash commands can take a while to show up. Use `DEV_GUILD_ID` while developing.
- Komodo: the compose service needs `env_file: .env` or the container gets no env. Network `proxy` is external and must already exist on the host.
- `DATA_DIR` must be writable by distroless `nonroot`: the Dockerfile copies an owned `/app/data` so the named volume inherits it. A bind mount would need `chown 65532`. The volume keeps its old pinned name.
- The alerts feed (`src/core/services/alerts.feed.ts`) posts what the ledger records, never `/v1/value-bets` directly, so Discord and the proof page match. It is live over `/v1/ws`; every (re)connect replays `GET /v1/ledger` past the watermark first. All state changes run through one promise chain, so catch up and live events never interleave. The watermark advances before sending, so a failed send is skipped, not retried. The first catch up without a state file posts nothing.
- The API's WebSocket closes a client silent for 60 s; the bot sends `{"type":"ping"}` every 20 s.
- DMs (`src/core/services/dm-alerts.ts`) record the delivery with the API before sending and send only on a created record (409 is a duplicate). Never reorder that: it is what keeps restarts and two instances from double sending. Arb deliveries use `arb:<id>` as `ledger_id`.
- A user who cannot be DMed is skipped for 6 hours and logged once per process; do not log or retry per alert.
- `openapi-typescript` needs the TypeScript 5 JS API, which TypeScript 7 lacks, so `api:types` runs it through `bunx` instead of a dev dependency.
- `DRY_RUN=1` never logs in, never writes `DATA_DIR` and records deliveries in memory; without `INTERNAL_TOKEN` it uses the mocked subscribers in `src/core/services/dry-run.ts`.
- The shipped artifact is the `bun build --compile` binary from the Dockerfile, not tsup's `dist/`. tsup only runs the import check.
