import { expect } from "vitest";
import { sha256Hex } from "./crypto";
import type { CollectorEnv } from "./types";

// Captured before product edits at cc01853. These are byte and canonical-payload
// equivalence checks, not performance measurements.
export async function assertCandidateFingerprint(env: CollectorEnv, fixture: string) {
  const stored = await env.FORECAST_DB.prepare(
    "SELECT payload_json,payload_hash FROM forecast_candidates ORDER BY revision LIMIT 1",
  ).first<{ payload_json: string; payload_hash: string }>();
  const actual = {
    payloadHash: stored?.payload_hash,
    byteHash: stored ? await sha256Hex(stored.payload_json) : null,
  };
  const expected =
    fixture === "staging-like-blocked"
      ? { payloadHash: undefined, byteHash: null }
      : fixture === "7833931"
        ? {
            payloadHash: "61d0e47326137c2ab3f9ed8a92ba3a5dd03683dc1d299e7ce7c48a31fbcb596f",
            byteHash: "1a162dff5141e6e23d9db55fd25e1b1201061a2b8df00af428153edf0f4f5ae5",
          }
        : {
            payloadHash: "838175fe91353f49723ff7e0ade31b4a0f6a9289b0664ef0c0cb8a82169e1c82",
            byteHash: "97fa645df56aabc8c75cf50b15a1fb2087b8280dbf1f869cf841e1ee75dc6de0",
          };
  expect(actual).toEqual(expected);
}
