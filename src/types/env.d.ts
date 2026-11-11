interface BotEnvironment {
  DISCORD_BOT_TOKEN?: string;
  DEV_GUILD_ID?: string;
  BOT_NAME?: string;
  BOT_ACTIVITY?: string;
  LOG_LEVEL?: string;
  DATA_DIR?: string;
  OPENEV_API_URL?: string;
  OPENEV_WS_URL?: string;
  OPENEV_WEBSITE_URL?: string;
  INTERNAL_TOKEN?: string;
  DRY_RUN?: string;
  DRY_RUN_SAMPLES?: string;
}

declare namespace NodeJS {
  export interface ProcessEnv extends BotEnvironment {}
}
