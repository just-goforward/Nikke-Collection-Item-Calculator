import { KIT_ORDER } from "../../shared/game";
import { type CertifiedBatch, unresolvedCertifiedSuccess } from "./calculatorSessionActions";
import { type CertifiedSession, restoreCertifiedSession } from "./session";

export type CertifiedCalculatorSession = {
  session: CertifiedSession;
  correction: CertifiedBatch | null;
};

const PENDING_KIND = "certified_pending_stock_correction";
// Two native sessions, each with the existing 2 MB storage limit, plus batch metadata.
const MAX_STORAGE_LENGTH = 4_100_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidStorage(): never {
  throw new Error("invalid_certified_calculator_storage");
}

function sessionFromValue(value: unknown): CertifiedSession {
  if (!record(value)) return invalidStorage();
  const session = restoreCertifiedSession(JSON.stringify(value));
  return session ?? invalidStorage();
}

function pendingBatchFromValue(raw: unknown): CertifiedBatch {
  if (!record(raw)) return invalidStorage();
  const kit = KIT_ORDER.find((kit) => kit === raw["kit"]);
  const uses = raw["uses"];
  const at = raw["at"];
  if (
    !kit ||
    typeof uses !== "number" ||
    !Number.isInteger(uses) ||
    uses < 2 ||
    uses > 10 ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at))
  )
    return invalidStorage();
  const before = sessionFromValue(raw["before"]);
  if (before.state.level === 15 || (before.stock[KIT_ORDER.indexOf(kit)] ?? 0) < uses * 10)
    return invalidStorage();
  return { before, kit, uses, at };
}

function restorePendingEnvelope(value: Record<string, unknown>): CertifiedCalculatorSession {
  if (value["kind"] !== PENDING_KIND || value["version"] !== 1) return invalidStorage();
  const correction = pendingBatchFromValue(value["correction"]);
  const session = sessionFromValue(value["session"]);
  // Only observed state and entered stock may differ. Normalized native sessions make
  // equivalent rational weights compare equally, and reject injected receipts/outcomes.
  const expected = { ...unresolvedCertifiedSuccess(correction), stock: session.stock };
  if (JSON.stringify(session) !== JSON.stringify(expected)) return invalidStorage();
  return { session, correction };
}

/** Settled sessions retain their original wire shape. Pending successes are never treated as settled. */
export function restoreCertifiedCalculatorSession(
  text: string | null,
): CertifiedCalculatorSession | null {
  if (text === null) return null;
  if (!text || text.length > MAX_STORAGE_LENGTH) return invalidStorage();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidStorage();
  }
  if (!record(value)) return invalidStorage();
  if ("kind" in value) return restorePendingEnvelope(value);
  const session = restoreCertifiedSession(text);
  return session ? { session, correction: null } : invalidStorage();
}

export function serializeCertifiedCalculatorSession(
  session: CertifiedSession,
  correction: CertifiedBatch | null,
): string {
  const text = JSON.stringify(
    correction ? { kind: PENDING_KIND, version: 1, session, correction } : session,
  );
  // The same boundary validation applies to writes and reloads.
  const validated = restoreCertifiedCalculatorSession(text);
  if (!validated) return invalidStorage();
  return JSON.stringify(
    validated.correction ? { kind: PENDING_KIND, version: 1, ...validated } : validated.session,
  );
}
