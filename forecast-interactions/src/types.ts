export type InteractionRouterEnv = {
  STAGING_FORECAST_DB: D1Database;
  PRODUCTION_FORECAST_DB: D1Database;
  USAGE_GUARD_DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_APPROVER_USER_ID: string;
  DISCORD_APPROVAL_CHANNEL_ID: string;
  DISCORD_ALERT_CHANNEL_ID: string;
  DISCORD_ACTIVITY_CHANNEL_ID: string;
  DEPLOY_SHA: string;
  PRODUCTION_MUTATIONS_ENABLED: string;
};

export type InteractionEnvironment = "staging" | "production";
