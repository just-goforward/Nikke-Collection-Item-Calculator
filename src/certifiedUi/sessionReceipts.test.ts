import { describe, expect, it } from "vitest";
import {
  activeCertifiedReceiptIds,
  createCertifiedSession,
  reconcileCertifiedSession,
} from "./session";

describe("durable receipt identity", () => {
  it("hides mismatched dates and reactivates the original identity without deleting receipts", () => {
    const original = { id: "solo:r38:day1", gameDate: "2026-06-18" };
    const session = {
      ...createCertifiedSession("old", { grade: "R", level: 0, exp: 0 }, [1, 2, 3]),
      receipts: [
        {
          eventId: original.id,
          gameDate: original.gameDate,
          at: "2026-06-18T12:00:00+09:00",
          pieces: null,
          alreadyInStock: true,
        },
      ],
    };
    const wrongDate = [{ ...original, gameDate: "2026-07-03" }];
    const hidden = reconcileCertifiedSession(session, "changed", wrongDate);
    expect(hidden.receipts).toEqual(session.receipts);
    expect(hidden.retiredReceiptIds).toEqual([original.id]);
    expect(hidden.migrationNotice).toBe("receipts_hidden");
    expect(activeCertifiedReceiptIds(hidden, wrongDate)).toEqual([]);
    const restored = reconcileCertifiedSession(hidden, "returned", [original]);
    expect(restored.receipts).toEqual(session.receipts);
    expect(restored.retiredReceiptIds).toEqual([]);
    expect(restored.migrationNotice).toBeUndefined();
    expect(activeCertifiedReceiptIds(restored, [original])).toEqual([original.id]);
    expect(restored.stock).toEqual([1, 2, 3]);
  });
});
