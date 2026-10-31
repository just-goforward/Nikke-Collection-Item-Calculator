import { afterEach, expect, it, vi } from "vitest";
import { sha256Hex } from "./crypto.ts";
import type { DispatcherEnv } from "./types.ts";
import { drainV2Outbox } from "./v2-outbox.ts";

afterEach(() => vi.unstubAllGlobals());
async function fixture(attempts = 0, commitFailure = false, calendarChanged = false) {
  const payload = JSON.stringify(calendarChanged ? {
    snapshotId: "snapshot", revision: 3,
    adminUrl: "https://forecast-admin-staging.nikkecollection.com/?rev=3#gd-2026-10-18",
    changes: [],
  } : { decisionRequestId: "one" });
  const row = {
    outbox_id: "one",
    kind: calendarChanged ? "calendar_changed" : "decision_reminder",
    payload_json: payload,
    payload_hash: await sha256Hex(payload),
    idempotency_key: "key",
    channel_role: "approval",
    attempts,
    expected_calendar_revision: 3,
  };
  let done = false;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: done ? [] : [{ ...row }] };
        },
        async run() {
          if (sql.includes("state='sending',attempts")) row.attempts++;
          if (sql.includes("state='sent'")) {
            if (commitFailure) {
              commitFailure = false;
              throw new Error("commit failed");
            }
            done = true;
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  const env = {
    FORECAST_V2_NOTIFICATIONS_ENABLED: "true",
    FORECAST_DB: db,
    ENVIRONMENT: "staging",
    DISCORD_APPROVAL_CHANNEL_ID: "123456789",
    DISCORD_ACTIVITY_CHANNEL_ID: "987654321",
    DISCORD_BOT_TOKEN: "fake",
  } as DispatcherEnv;
  return env;
}
it("routes calendar changes to activity despite a persisted approval role", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: "123456789" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture(0, false, true))).toBe(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://discord.com/api/v10/channels/987654321/messages",
    expect.any(Object),
  );
});
it("reconciles an old-channel send instead of posting to the new channel", async () => {
  const fetcher = vi.fn(async (_url: string) =>
    Response.json([{ id: "123456789", embeds: [{ footer: { text: "ref:key" } }] }]),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture(1, false, true))).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toContain("/123456789/messages?limit=50");
});
it("never resends a cross-channel ambiguous attempt outside the history window", async () => {
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture(1, false, true))).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("immediately retries an ambiguous send with the identical nonce", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(Response.json({ id: "123456789" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture())).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
});
it.each([true, false])("reconciles later retries, marker found=%s", async (found) => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(found ? [{ id: "123456789", embeds: [{ footer: { text: "ref:key" } }] }] : []),
    )
    .mockResolvedValueOnce(Response.json({ id: "123456789" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture(1))).toBe(1);
  expect(fetcher.mock.calls[0]![0]).toContain("?limit=50");
  expect(fetcher).toHaveBeenCalledTimes(found ? 1 : 2);
});
it("reconciles a successful send whose database commit failed without resending", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: "123456789" }))
    .mockResolvedValueOnce(
      Response.json([{ id: "123456789", embeds: [{ footer: { text: "ref:key" } }] }]),
    );
  vi.stubGlobal("fetch", fetcher);
  const env = await fixture(0, true);
  expect(await drainV2Outbox(env)).toBe(0);
  expect(await drainV2Outbox(env)).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![0]).toContain("?limit=50");
});
it("sends a legacy reminder payload with the actionable fallback layout", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ id: "123456789" }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture())).toBe(1);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    embeds: { description: string; footer: { text: string } }[];
  };
  const description = body.embeds[0]?.description ?? "";
  expect(description).toContain("하려던 일:");
  expect(description).toContain("❌ 막힌 이유:");
  expect(description).toContain("👉 해 주실 일:");
  expect(description).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  expect(body.embeds[0]?.footer.text).toBe("ref:key");
});
it.each([429, 403, 503])("handles HTTP %s without unbounded sends", async (status) => {
  const fetcher = vi.fn(async () => Response.json({ retry_after: 90 }, { status }));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture())).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
});
