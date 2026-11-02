import { expect, it } from "vitest";
import { resolveDiscordChannelId } from "./discord.ts";
import type { DispatcherEnv } from "./types.ts";

const env = {
  DISCORD_APPROVAL_CHANNEL_ID: "1561375802027810957",
  DISCORD_ACTIVITY_CHANNEL_ID: "1561375968441143306",
  DISCORD_ALERT_CHANNEL_ID: "1561375802027810957",
  DISCORD_FALLBACK_CHANNEL_ID: "1561375802027810957",
  DISCORD_CHANNEL_ID: "1561375802027810957",
} as DispatcherEnv;

it("keeps approval and activity separate", () => {
  expect(resolveDiscordChannelId(env, "approval")).toBe("1561375802027810957");
  expect(resolveDiscordChannelId(env, "activity")).toBe("1561375968441143306");
});

it("never falls back to approval for non-approval delivery", () => {
  expect(() => resolveDiscordChannelId(env, "alert")).toThrow();
  expect(() =>
    resolveDiscordChannelId({ ...env, DISCORD_ACTIVITY_CHANNEL_ID: "unset" }, "activity"),
  ).toThrow();
});
