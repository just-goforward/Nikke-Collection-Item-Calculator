import { afterEach, expect, it, vi } from "vitest";
import { sha256Hex } from "./crypto.ts";
import type { DispatcherEnv } from "./types.ts";
import { drainV2Outbox } from "./v2-outbox.ts";

afterEach(() => vi.unstubAllGlobals());
async function fixture(attempts = 0, commitFailure = false) {
  const payload = JSON.stringify({ decisionRequestId: "one" });
  const row = {
    outbox_id: "one",
    kind: "decision_reminder",
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
    DISCORD_BOT_TOKEN: "fake",
  } as DispatcherEnv;
  return env;
}
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
it.each([429, 403, 503])("handles HTTP %s without unbounded sends", async (status) => {
  const fetcher = vi.fn(async () => Response.json({ retry_after: 90 }, { status }));
  vi.stubGlobal("fetch", fetcher);
  expect(await drainV2Outbox(await fixture())).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
});
