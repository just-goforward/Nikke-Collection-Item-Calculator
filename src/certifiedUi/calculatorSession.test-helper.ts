import { createCertifiedSession } from "./session";

export function sessionFixture() {
  const session = createCertifiedSession(
    "approved",
    { grade: "SR", level: 2, exp: 0 },
    [79, 13, 7],
  );
  return {
    ...session,
    cohortWeights: [
      { numerator: "1", denominator: "2" },
      { numerator: "1", denominator: "3" },
      { numerator: "1", denominator: "6" },
      { numerator: "0", denominator: "1" },
    ] as const,
    receipts: [
      {
        eventId: "actual-receipt",
        at: "2026-09-30T02:00:00Z",
        pieces: [3, 0, 0] as const,
        alreadyInStock: true,
      },
    ],
    retiredReceiptIds: ["actual-receipt"],
  };
}
