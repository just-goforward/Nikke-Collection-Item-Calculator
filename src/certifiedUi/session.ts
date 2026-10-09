import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import {
  add,
  cmp,
  div,
  fromWire,
  mul,
  ONE,
  type Q,
  sum,
  toWire,
  type WireQ,
  ZERO,
} from "../../shared/certifiedRational";
import {
  type CertifiedSupplyEvent,
  getCertifiedEventDistribution,
} from "../../shared/certifiedSupply";
import type { CertifiedLawOptions, Triple } from "../../shared/certifiedSupplyLaws";
import {
  type CollectionState,
  failOnce,
  greatSuccessState,
  KIT_ORDER,
  type Kit,
  MAX_STOCK_PIECES,
  REQUIRED_EXP,
} from "../../shared/game";
import { gameDayKey } from "../../shared/supplyForecastModel";

type CertifiedReceipt = {
  eventId: string;
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
  version: 1;
  id: string;
  profileId: "certified-staging-v1";
  snapshotRevision: string;
  state: CollectionState;
  stock: Triple;
  cohortWeights: readonly [WireQ, WireQ, WireQ];
  receipts: readonly CertifiedReceipt[];
  retiredReceiptIds: readonly string[];
  outcomes: readonly CertifiedOutcome[];
};
export const CERTIFIED_SESSION_STORAGE_KEY = `${CERTIFIED_STAGING_ENGINE_PROFILE.sessionNamespace}:session`;
const EQUAL_WEIGHTS = [
  { numerator: "1", denominator: "3" },
  { numerator: "1", denominator: "3" },
  { numerator: "1", denominator: "3" },
] as const;

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
    version: 1,
    id: crypto.randomUUID(),
    profileId: "certified-staging-v1",
    snapshotRevision,
    state: { ...state },
    stock: [...stock],
    cohortWeights: EQUAL_WEIGHTS,
    receipts: [],
    retiredReceiptIds: [],
    outcomes: [],
  };
}

/** Untrusted browser storage is parsed before it can reach the engine. Other namespaces are never read. */
export function restoreCertifiedSession(text: string | null): CertifiedSession | null {
  if (!text || text.length > 2_000_000) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const core = restoreSessionCore(value);
    const weights = restoreCohortWeights(value["cohortWeights"]);
    const receipts = restoreReceipts(value["receipts"]);
    const outcomes = restoreLedgerEntries(value["outcomes"], restoreOutcome);
    const retired = restoreRetiredReceiptIds(value["retiredReceiptIds"]);
    if (!core || !weights || !receipts || !outcomes || !retired) return null;
    return {
      version: 1,
      profileId: "certified-staging-v1",
      ...core,
      cohortWeights: weights,
      receipts,
      outcomes,
      retiredReceiptIds: retired,
    };
  } catch {
    return null;
  }
}

function restoreSessionCore(
  value: Record<string, unknown>,
): Pick<CertifiedSession, "id" | "snapshotRevision" | "state" | "stock"> | null {
  if (
    value["version"] !== 1 ||
    value["profileId"] !== "certified-staging-v1" ||
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

function restoreCohortWeights(value: unknown): [WireQ, WireQ, WireQ] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const weights: [WireQ, WireQ, WireQ] = [wire(value[0]), wire(value[1]), wire(value[2])];
  if (weights.some((w) => cmp(fromWire(w), ZERO) < 0) || cmp(sum(weights.map(fromWire)), ONE) !== 0)
    return null;
  return weights;
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
  if (!receipts || new Set(receipts.map((r) => r.eventId)).size !== receipts.length) return null;
  return receipts;
}

function restoreReceipt(value: unknown): CertifiedReceipt | null {
  if (
    !isRecord(value) ||
    typeof value["eventId"] !== "string" ||
    !isoTime(value["at"]) ||
    typeof value["alreadyInStock"] !== "boolean" ||
    !(validStock(value["pieces"]) || (value["pieces"] === null && value["alreadyInStock"]))
  )
    return null;
  const pieces = value["pieces"];
  return {
    eventId: value["eventId"],
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
  activeIds: readonly string[],
): CertifiedSession {
  const active = new Set(activeIds);
  return {
    ...session,
    snapshotRevision,
    retiredReceiptIds: session.receipts.filter((r) => !active.has(r.eventId)).map((r) => r.eventId),
  };
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

export function certifiedClaimableEvents(
  events: readonly CertifiedSupplyEvent[],
  session: CertifiedSession,
  nowMs: number,
) {
  const received = new Set(session.receipts.map((r) => r.eventId));
  return events.filter(
    (event) =>
      !received.has(event.id) &&
      !event.cancelled &&
      event.status === "confirmed" &&
      Date.parse(event.at) <= nowMs &&
      (event.gameDate === gameDayKey(nowMs) ||
        (event.expiresAt !== undefined && event.expiresAt !== null)) &&
      (event.expiresAt === undefined ||
        event.expiresAt === null ||
        Date.parse(event.expiresAt) > nowMs),
  );
}

/** A user can acknowledge a reward already included in the input without fabricating its observed pieces. */
export function acknowledgeCertifiedReceipt(
  session: CertifiedSession,
  event: CertifiedSupplyEvent,
  at: string,
): CertifiedSession {
  if (!isoTime(at) || !certifiedClaimableEvents([event], session, Date.parse(at)).length)
    throw new Error("receipt_not_claimable");
  return {
    ...session,
    receipts: [...session.receipts, { eventId: event.id, at, pieces: null, alreadyInStock: true }],
  };
}

/** Observed pieces update the single latent cohort posterior; all future days share that posterior. */
export function recordCertifiedReceipt(
  session: CertifiedSession,
  event: CertifiedSupplyEvent,
  pieces: Triple,
  at: string,
  alreadyInStock = false,
  lawOptions: CertifiedLawOptions = {},
): CertifiedSession {
  if (!validStock(pieces) || !isoTime(at)) throw new Error("invalid_receipt");
  if (!certifiedClaimableEvents([event], session, Date.parse(at)).length)
    throw new Error("receipt_not_claimable");
  const posteriorMass = (cohort: 0 | 1 | 2) => {
    let likelihood = ZERO;
    for (const outcome of getCertifiedEventDistribution(event, cohort, lawOptions)) {
      if (outcome.pieces.every((n, i) => n === pieces[i]))
        likelihood = add(likelihood, outcome.mass);
    }
    return mul(fromWire(session.cohortWeights[cohort]), likelihood);
  };
  const unnormalized: [Q, Q, Q] = [posteriorMass(0), posteriorMass(1), posteriorMass(2)];
  const normalizer = sum(unnormalized);
  if (cmp(normalizer, ZERO) === 0) throw new Error("receipt_outside_supply_model");
  const posterior = (mass: Q) => toWire(div(mass, normalizer));
  const weights: [WireQ, WireQ, WireQ] = [
    posterior(unnormalized[0]),
    posterior(unnormalized[1]),
    posterior(unnormalized[2]),
  ];
  const stock: [number, number, number] = [0, 1, 2].map(
    (i) => (session.stock[i] ?? 0) + (alreadyInStock ? 0 : (pieces[i] ?? 0)),
  ) as [number, number, number];
  if (!validStock(stock)) throw new Error("stock_limit");
  return {
    ...session,
    stock,
    cohortWeights: weights,
    receipts: [...session.receipts, { eventId: event.id, at, pieces: [...pieces], alreadyInStock }],
  };
}
