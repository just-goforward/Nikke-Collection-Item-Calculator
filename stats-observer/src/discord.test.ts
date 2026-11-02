import { describe, expect, it, vi } from "vitest";
import { deliverAlert } from "./discord";
import type { ObserverAlertRow, StatsObserverEnv } from "./types";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function alert(overrides: Partial<ObserverAlertRow> = {}): ObserverAlertRow {
  return {
    fingerprint: "c".repeat(64),
    source_kind: "solver_failure",
    severity: "critical",
    state: "open",
    error_code: "memo_full",
    context_json: "not-json",
    first_seen: new Date(NOW).toISOString(),
    last_seen: new Date(NOW).toISOString(),
    window_started_at: new Date(NOW).toISOString(),
    window_count: 1,
    total_count: 1,
    last_sent_at: null,
    last_sent_severity: null,
    discord_message_id: null,
    next_send_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const env = {
  ENVIRONMENT: "staging",
  DISCORD_BOT_TOKEN: "test-discord-token",
  DISCORD_ALERT_CHANNEL_ID: "123456789012345678",
} as StatsObserverEnv;

describe("discord alert delivery fallbacks", () => {
  it("degrades a malformed legacy context instead of suppressing the alert", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "987654321098765432" }));

    expect(await deliverAlert(env, alert(), fetchImpl, NOW)).toBe("987654321098765432");

    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: "observer_alert_context_invalid",
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      embeds: Array<{ description: string }>;
    };
    expect(body.embeds[0]?.description).toContain("오류 범주: `memo_full`");
    warning.mockRestore();
  });

  it("keeps the conservative durable fallback and records the category when retry_after is unusable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ retry_after: "invalid" }, { status: 429 }));

    await expect(
      deliverAlert(env, alert({ context_json: "{}" }), fetchImpl, NOW),
    ).rejects.toMatchObject({ code: "discord_429", retryable: true, retryAfterMs: 5 * 60_000 });
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: "observer_discord_retry_metadata_invalid",
    });
    warning.mockRestore();
  });

  it("records the category when the retry body is not readable JSON at all", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json", { status: 429 }));

    await expect(
      deliverAlert(env, alert({ context_json: "{}" }), fetchImpl, NOW),
    ).rejects.toMatchObject({ code: "discord_429", retryAfterMs: 5 * 60_000 });
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: "observer_discord_retry_metadata_invalid",
    });
    warning.mockRestore();
  });

  it("records the fixed category without any Discord body text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ retry_after: "SENTINEL_retry_body_secret" }, { status: 429 }),
      );

    await deliverAlert(env, alert({ context_json: "{}" }), fetchImpl, NOW).catch(() => undefined);

    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).toContain("observer_discord_retry_metadata_invalid");
    expect(logged).not.toContain("SENTINEL_retry_body_secret");
    warning.mockRestore();
  });

  it("uses Discord's retry_after when it is a usable delay", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ retry_after: 65 }, { status: 429 }));

    await expect(
      deliverAlert(env, alert({ context_json: "{}" }), fetchImpl, NOW),
    ).rejects.toMatchObject({ code: "discord_429", retryable: true, retryAfterMs: 65_000 });
  });
});
