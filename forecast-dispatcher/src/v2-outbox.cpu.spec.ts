import { expect, it, vi } from "vitest";
import { sha256Hex } from "./crypto.ts";
import type { DispatcherEnv } from "./types.ts";
import { drainV2Outbox } from "./v2-outbox.ts";

it("Node proxy: complete dispatch unit including row load, hashing, render, fake send and commit stays below 20 ms", async () => {
  const payload = JSON.stringify({
    decisionRequestId: "one",
    type: "grant_date",
    feedIds: [1],
    title: "**공지** @everyone",
    url: "https://game.naver.com/lounge/nikke/board/detail/1",
    options: Array.from({ length: 25 }, (_, i) => ({ id: String(i), label: "날짜 선택" })),
    expiresAt: "2026-11-01T00:00:00Z",
  });
  const row = {
    outbox_id: "one",
    kind: "decision_request",
    payload_json: payload,
    payload_hash: await sha256Hex(payload),
    idempotency_key: "key",
    channel_role: "approval",
    attempts: 0,
    expected_calendar_revision: 7,
  };
  let loads = 0,
    commits = 0,
    sends = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async all() {
          loads++;
          return { results: [{ ...row }] };
        },
        async run() {
          if (sql.includes("state='sent'")) commits++;
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
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const message = JSON.parse(String(init.body));
    if (message.components.length !== 5 || message.enforce_nonce !== true)
      throw new Error("incomplete dispatch");
    sends++;
    return Response.json({ id: "123456789" });
  });
  try {
    for (let i = 0; i < 20; i++) await drainV2Outbox(env);
    const elapsed: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const sent = await drainV2Outbox(env);
      elapsed.push(performance.now() - start);
      expect(sent).toBe(1);
    }
    expect({ loads, commits, sends }).toEqual({ loads: 120, commits: 120, sends: 120 });
    expect(Math.max(...elapsed)).toBeLessThan(20);
    console.info(`complete v2 dispatch Node proxy maximum: ${Math.max(...elapsed).toFixed(3)} ms`);
  } finally {
    vi.unstubAllGlobals();
  }
});
