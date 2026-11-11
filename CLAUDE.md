# CLAUDE.md: openev-bot

Product decisions live in `../claude.md`. The web app and API are the separate `openev` repo (github.com/openplusev/openev).

## Rules

- bun for everything. No tests unless asked.
- No dashes as punctuation (em, en, `--`), no Unicode arrows, curly quotes or ellipsis, no emojis. Applies to code, comments, docs, embeds and commit messages.
- Comments only for a non obvious why, one terse line.
- Never `as` to silence a type. The single allowed cast is the JSON boundary in `src/lib/api.ts`.
- No barrel files. No TS enums: union literals derived from `as const` arrays (`src/shared/config/sports.ts`).
- No database here. State belongs to the API; add an endpoint there instead of storing anything in the bot. The one exception is the results feed watermark file in `DATA_DIR`.
- Brand strings come from env (`BOT_NAME`, `WEBSITE_URL`). Never hardcode Discord IDs; if a channel is ever needed, resolve it by name.
- No Co-Authored-By or AI references in git.

## Traps

- Every file in `src/bot/commands` must be imported in `src/bot/index.ts`. discordx registers by import side effect; `bun run build` (tsup) fails on a missing or stale import.
- The API contract is mirrored by hand in `src/lib/api.ts` and the README table. Change both repos together.
- `/pick` defers publicly, so checks that need no odds reply ephemerally before deferring. After that, `replyFailure` edits the error into the deferred reply and deletes it after a minute; deleting first and following up leaves a "Message could not be loaded" stub. A non `ApiError` is rethrown to the `ErrorBoundary` guard.
- Autocomplete must answer within 3 seconds: events load with a 2 second timeout, are cached per sport for 60 seconds, and a failed refresh serves the stale list.
- discordx passes a `User` option as the `GuildMember` when there is one, which has no `username`. Read only `.id` from it.
- Global slash commands can take a while to show up. Use `DEV_GUILD_ID` while developing.
- `/record` and `/verify #N` look users up by Discord id (`findCapperByDiscordId`), never by name.
- `?pick=` on the verify page is the global pick id (`ApiPick.id`), never the per capper `sequence`.
- Units mirror the API's `PICK_UNITS_*`; change `UNITS` with it.
- Komodo: the compose service needs `env_file: .env` or the container gets no env. Network `proxy` is external and must already exist on the host.
- The results feed (`src/core/services/results.feed.ts`) starts in `clientReady`, is single flight and must never throw. It posts only to channels resolved by `RESULTS_CHANNEL` name substring where the bot can send embeds. Watermarks advance per posted pick, so a failed send is skipped, not retried. The API returns at most 100 rows strictly after `since` and has no id cursor, so more than 100 picks of one guild graded in one tick cannot all be posted; the feed logs and skips past them instead of stalling.
- `DATA_DIR` must be writable by distroless `nonroot`: the Dockerfile copies an owned `/app/data` so the named volume inherits it. A bind mount would need `chown 65532`.
- Picked side detection (`pickedSide` in `src/core/utils/pick.utils.ts`) matches selection words against team names; ties and totals fall back to the home image.
- The shipped artifact is the `bun build --compile` binary from the Dockerfile, not tsup's `dist/`. tsup only runs the import check.
