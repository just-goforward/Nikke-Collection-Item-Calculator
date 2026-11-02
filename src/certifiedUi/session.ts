import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { cmp, fromWire, ONE, sum, toWire, type WireQ, ZERO } from "../../shared/certifiedRational";
import {
  type CertifiedSupplyEvent,
  type CertifiedSupplySnapshot,
  isCertifiedEventClaimable,
} from "../../shared/certifiedSupply";
import type { Triple } from "../../shared/certifiedSupplyLaws";
import {
  type CollectionState,
  failOnce,
  greatSuccessState,
  KIT_ORDER,
  type Kit,
  MAX_STOCK_PIECES,
  REQUIRED_EXP,
} from "../../shared/game";

type CertifiedReceipt = {
  eventId: string;
  gameDate?: string;
  at: string;
  pieces: Triple | null;
  alreadyInStock: boolean;
};
type CertifiedOutcome = {
  kit: Kit;
  outcome: "normal" | "great";
  at: string;
  before: CollectionState;
  after: CollectionState;
};
export type CertifiedSession = {
  version: 2;
  id: string;
  profileId: typeof CERTIFIED_STAGING_ENGINE_PROFILE.id;
  snapshotRevision: string;
  state: CollectionState;
  stock: Triple;
  receipts: readonly CertifiedReceipt[];
  retiredReceiptIds: readonly string[];
  outcomes: readonly CertifiedOutcome[];
  migrationNotice?: "cohort_prior_reset" | "receipts_hidden";
};
export const CERTIFIED_SESSION_STORAGE_KEY = `${CERTIFIED_STAGING_ENGINE_PROFILE.sessionNamespace}:session`;
const LEGACY_CERTIFIED_SESSION_STORAGE_KEY = "collection-certified-staging-v1:session";
export const CERTIFIED_SESSION_READ_KEYS = [
  CERTIFIED_SESSION_STORAGE_KEY,
  "collection-certified-staging-v3:session",
  "collection-certified-staging-v2:session",
  LEGACY_CERTIFIED_SESSION_STORAGE_KEY,
] as const;

/** Preserve precedence and malformed current bytes; never silently select older stock. */
export function readStoredCertifiedSession(storage: Pick<Storage, "getItem">): string | null {
  for (const key of CERTIFIED_SESSION_READ_KEYS) {
    const text = storage.getItem(key);
    if (text !== null) return text;
  }
  return null;
}

function validStock(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_STOCK_PIECES)
  );
}
function validState(value: unknown): value is CollectionState {
  if (typeof value !== "object" || value === null) return false;
  const grade = Reflect.get(value, "grade"),
    level = Reflect.get(value, "level"),
    exp = Reflect.get(value, "exp");
  if (grade !== "R" && grade !== "SR") return false;
  return validLevel(level) && validExperience(grade, level, exp);
}
function validLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 15;
}
function validExperience(grade: "R" | "SR", level: number, exp: unknown) {
  return (
    typeof exp === "number" &&
    Number.isInteger(exp) &&
    exp >= 0 &&
    exp % 100 === 0 &&
    exp < (grade === "R" ? REQUIRED_EXP.R : REQUIRED_EXP.SR) &&
    (level !== 15 || exp === 0)
  );
}
function isoTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
type SavedMigrationNotice =
  | NonNullable<CertifiedSession["migrationNotice"]>
  | "cohort_posterior_replayed"
  | "cohort_selection_kept";
function validMigrationNotice(value: unknown): value is SavedMigrationNotice {
  return (
    value === "cohort_prior_reset" ||
    value === "cohort_posterior_replayed" ||
    value === "cohort_selection_kept" ||
    value === "receipts_hidden"
  );
}
function wire(value: unknown): WireQ {
  if (
    !isRecord(value) ||
    typeof value["numerator"] !== "string" ||
    typeof value["denominator"] !== "string"
  )
    throw new Error("invalid_weights");
  return toWire(fromWire({ numerator: value["numerator"], denominator: value["denominator"] }));
}

export function createCertifiedSession(
  snapshotRevision: string,
  state: CollectionState,
  stock: Triple,
): CertifiedSession {
  if (!validState(state) || !validStock(stock))
    throw new RangeError("invalid_certified_session_input");
  return {
    version: 2,
    id: crypto.randomUUID(),
    profileId: CERTIFIED_STAGING_ENGINE_PROFILE.id,
    snapshotRevision,
    state: { ...state },
    stock: [...stock],
    receipts: [],
    retiredReceiptIds: [],
    outcomes: [],
  };
}

/** Certified historical readers preserve the ledger but discard personal inference.
 * The optional original snapshot is accepted for old callers, never used to infer
 * a receipt posterior under the fixed dispatch policy.
 */
export function restoreCertifiedSession(
  text: string | null,
  _originalSnapshot?: CertifiedSupplySnapshot,
): CertifiedSession | null {
  if (!text || text.length > 2_000_000) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const core = restoreSessionCore(value);
    const legacy = value["version"] === 1;
    const current = value["profileId"] === CERTIFIED_STAGING_ENGINE_PROFILE.id;
    const weights = value["cohortWeights"];
    if (weights !== undefined && !restoreCohortWeights(weights, legacy || current)) return null;
    const receipts = restoreReceipts(value["receipts"]);
    const outcomes = restoreLedgerEntries(value["outcomes"], restoreOutcome);
    const retired = restoreRetiredReceiptIds(value["retiredReceiptIds"]);
    if (!core || !receipts || !outcomes || !retired) return null;
    const notice = value["migrationNotice"];
    if (notice !== undefined && !validMigrationNotice(notice)) return null;
    return {
      version: 2,
      profileId: CERTIFIED_STAGING_ENGINE_PROFILE.id,
      ...core,
      ...cohortMigrationNotice(weights !== undefined, current, notice),
      receipts,
      outcomes,
      retiredReceiptIds: retired,
    };
  } catch {
    return null;
  }
}

function cohortMigrationNotice(
  hadWeights: boolean,
  current: boolean,
  notice: SavedMigrationNotice | undefined,
): Pick<CertifiedSession, "migrationNotice"> {
  return {
    ...(!current ||
    hadWeights ||
    notice === "cohort_posterior_replayed" ||
    notice === "cohort_selection_kept"
      ? { migrationNotice: "cohort_prior_reset" as const }
      : notice
        ? { migrationNotice: notice }
        : {}),
  };
}

function restoreSessionCore(
  value: Record<string, unknown>,
): Pick<CertifiedSession, "id" | "snapshotRevision" | "state" | "stock"> | null {
  if (
    !(
      (value["version"] === 1 && value["profileId"] === "certified-staging-v1") ||
      (value["version"] === 2 &&
        (value["profileId"] === "certified-staging-v2" ||
          value["profileId"] === "certified-staging-v3" ||
          value["profileId"] === CERTIFIED_STAGING_ENGINE_PROFILE.id))
    ) ||
    typeof value["id"] !== "string" ||
    typeof value["snapshotRevision"] !== "string" ||
    !validStock(value["stock"]) ||
    !validState(value["state"])
  )
    return null;
  return {
    id: value["id"],
    snapshotRevision: value["snapshotRevision"],
    state: { ...value["state"] },
    stock: [...value["stock"]],
  };
}

function restoreCohortWeights(value: unknown, threeCohorts: boolean): readonly WireQ[] | null {
  if (!Array.isArray(value) || value.length !== (threeCohorts ? 3 : 4)) return null;
  const weights = value.map(wire);
  if (weights.some((w) => cmp(fromWire(w), ZERO) < 0) || cmp(sum(weights.map(fromWire)), ONE) !== 0)
    return null;
  return weights;
}

export function dismissCertifiedMigrationNotice(session: CertifiedSession): CertifiedSession {
  const next = { ...session };
  delete next.migrationNotice;
  return next;
}

function restoreLedgerEntries<T>(
  value: unknown,
  restore: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const entries: T[] = [];
  for (const raw of value) {
    const entry = restore(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

function restoreReceipts(value: unknown): CertifiedReceipt[] | null {
  const receipts = restoreLedgerEntries(value, restoreReceipt);
  if (
    !receipts ||
    new Set(receipts.map((r) => `${r.eventId}|${r.gameDate ?? ""}`)).size !== receipts.length
  )
    return null;
  return receipts;
}

function restoreReceipt(value: unknown): CertifiedReceipt | null {
  if (
    !isRecord(value) ||
    typeof value["eventId"] !== "string" ||
    (value["gameDate"] !== undefined &&
      (typeof value["gameDate"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value["gameDate"]))) ||
    !isoTime(value["at"]) ||
    typeof value["alreadyInStock"] !== "boolean" ||
    !(validStock(value["pieces"]) || (value["pieces"] === null && value["alreadyInStock"]))
  )
    return null;
  const pieces = value["pieces"];
  return {
    eventId: value["eventId"],
    ...(typeof value["gameDate"] === "string" ? { gameDate: value["gameDate"] } : {}),
    at: value["at"],
    pieces: validStock(pieces) ? [...pieces] : null,
    alreadyInStock: value["alreadyInStock"],
  };
}

function restoreOutcome(value: unknown): CertifiedOutcome | null {
  if (!isRecord(value)) return null;
  const kit = KIT_ORDER.find((k) => k === value["kit"]);
  if (
    !kit ||
    (value["outcome"] !== "normal" && value["outcome"] !== "great") ||
    !isoTime(value["at"]) ||
    !validState(value["before"]) ||
    !validState(value["after"])
  )
    return null;
  return {
    kit,
    outcome: value["outcome"],
    at: value["at"],
    before: { ...value["before"] },
    after: { ...value["after"] },
  };
}

function restoreRetiredReceiptIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return null;
  return [...value];
}

export function reconcileCertifiedSession(
  session: CertifiedSession,
  snapshotRevision: string,
  activeEvents: readonly (string | Pick<CertifiedSupplyEvent, "id" | "gameDate">)[],
): CertifiedSession {
  const active = new Map(
    activeEvents.map((event) =>
      typeof event === "string" ? [event, undefined] : [event.id, event.gameDate],
    ),
  );
  const receipts = session.receipts.map((receipt) => {
    const gameDate = active.get(receipt.eventId);
    return receipt.gameDate === undefined && gameDate !== undefined
      ? { ...receipt, gameDate }
      : receipt;
  });
  const retiredReceiptIds = receipts
    .filter(
      (receipt) =>
        !active.has(receipt.eventId) ||
        (active.get(receipt.eventId) !== undefined &&
          receipt.gameDate !== active.get(receipt.eventId)),
    )
    .map((receipt) => receipt.eventId);
  const { migrationNotice, ...previous } = session;
  const notice =
    retiredReceiptIds.length > 0
      ? (migrationNotice ?? "receipts_hidden")
      : migrationNotice === "receipts_hidden"
        ? undefined
        : migrationNotice;
  return {
    ...previous,
    ...(notice ? { migrationNotice: notice } : {}),
    snapshotRevision,
    receipts,
    retiredReceiptIds,
  };
}

export function activeCertifiedReceiptIds(
  session: CertifiedSession,
  events: readonly Pick<CertifiedSupplyEvent, "id" | "gameDate">[],
): string[] {
  return events
    .filter((event) =>
      session.receipts.some(
        (receipt) =>
          receipt.eventId === event.id &&
          (receipt.gameDate === undefined || receipt.gameDate === event.gameDate),
      ),
    )
    .map((event) => event.id);
}
export function recordCertifiedOutcome(
  session: CertifiedSession,
  kit: Kit,
  outcome: "normal" | "great",
  at: string,
): CertifiedSession {
  const index = KIT_ORDER.indexOf(kit);
  if (session.state.level === 15) throw new Error("collection_complete_or_conversion_required");
  if ((session.stock[index] ?? 0) < 10) throw new Error("insufficient_stock");
  if (!isoTime(at)) throw new Error("invalid_receipt_time");
  const stock: [number, number, number] = [...session.stock];
  stock[index] = (stock[index] ?? 0) - 10;
  const after =
    outcome === "great" ? greatSuccessState(session.state) : failOnce(session.state, kit);
  return {
    ...session,
    stock,
    state: after,
    outcomes: [...session.outcomes, { kit, outcome, at, before: { ...session.state }, after }],
  };
}

export function convertCertifiedSession(session: CertifiedSession): CertifiedSession {
  if (session.state.grade !== "R" || session.state.level !== 15)
    throw new Error("conversion_not_available");
  return { ...session, state: { grade: "SR", level: 5, exp: 0 } };
}

/**
 * Received-event ids for an engine request: the stored receipts plus every reward claimable at
 * `asOf`. Users enter stock after receiving today's rewards, so a claimable reward counts as
 * already received and already in stock. Nothing is stored and no pieces are observed, so the
 * cohort weights stay unchanged (as with the former "already included in stock" receipt).
 */
export function certifiedRequestReceivedEventIds(
  session: CertifiedSession,
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
): string[] {
  const received = new Set(activeCertifiedReceiptIds(session, snapshot.events));
  return snapshot.events
    .filter((event) => received.has(event.id) || isCertifiedEventClaimable(snapshot, event, asOf))
    .map((event) => event.id);
}
