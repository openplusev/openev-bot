import pino from "pino";

const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === "development";

const root = pino({
  name: process.env.BOT_NAME?.trim() || "openev-bot",
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  redact: {
    paths: ["token", "*.token", "authorization", "*.authorization"],
    remove: true,
  },
});

type Attrs = Record<string, unknown> | undefined;

// Keeps the (msg, attrs) call shape and reorders to pino's native (attrs, msg).
const adapt =
  (level: "debug" | "info" | "warn" | "error") =>
  (msg: string, attrs?: Attrs) =>
    attrs ? root[level](attrs, msg) : root[level](msg);

export const logger = {
  debug: adapt("debug"),
  info: adapt("info"),
  warn: adapt("warn"),
  error: adapt("error"),
};
