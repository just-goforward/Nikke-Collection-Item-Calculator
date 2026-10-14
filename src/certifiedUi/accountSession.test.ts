import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import {
  type CertifiedAccountDeps,
  createCertifiedAccountPort,
  readGuestCertifiedSessionText,
  validateCertifiedSessionText,
} from "./accountSession";
import { serializeCertifiedCalculatorSession } from "./calculatorSessionPersistence";
import {
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  createCertifiedSession,
} from "./session";
import {
  type CertifiedBridgeState,
  persistCertifiedSession,
  settledCertifiedBridge,
} from "./useCertifiedCalculatorSession";

const stored = new Map<string, string>();

function session(stock: [number, number, number], revision = "approved"): CertifiedSession {
  return {
    ...createCertifiedSession(revision, { grade: "SR", level: 2, exp: 0 }, stock),
    id: `session-${stock.join("-")}`,
  };
}

function text(value: CertifiedSession) {
  return serializeCertifiedCalculatorSession(value, null);
}

function fixture(snapshot: CertifiedSupplySnapshot | null = null) {
  const published: CertifiedBridgeState[] = [];
  const deps = {
    latest: { current: settledCertifiedBridge(session([5, 0, 0])) },
    publish: vi.fn((next: CertifiedBridgeState) => {
      published.push(next);
      deps.latest.current = next;
    }),
    accountMode: { current: false },
    retire: vi.fn(),
    snapshotRef: { current: snapshot },
    updateSession: vi.fn(),
  } satisfies CertifiedAccountDeps;
  return { deps, published, port: createCertifiedAccountPort(() => deps) };
}

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("certified account read/apply API", () => {
  it("round-trips the live session through the storage format", () => {
    const { port, deps } = fixture();
    const current = port.current();
    expect(current).toBe(text(deps.latest.current.session));
    expect(port.validate(current)).toBe(current);
    expect(port.applyAccount(current)).toBe(true);
    expect(port.current()).toBe(current);
    expect(port.summary(current)).toEqual({
      grade: "SR",
      level: 2,
      exp: 0,
      stock: { blue: 5, purple: 0, yellow: 0 },
    });
  });

  it("rejects corrupt text whole: nothing is published, retired or switched", () => {
    const { port, deps } = fixture();
    const before = deps.latest.current;
    const bad = { ...JSON.parse(text(session([5, 0, 0]))), stock: [5, 0.5, 0] };
    for (const corrupt of ["", "{", "[]", JSON.stringify(bad)]) {
      expect(port.validate(corrupt)).toBeNull();
      expect(port.applyAccount(corrupt)).toBe(false);
    }
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.accountMode.current).toBe(false);
    expect(deps.latest.current).toBe(before);
  });

  it("an applied account session is never written to the guest storage key", () => {
    const { port, deps } = fixture();
    stored.set(CERTIFIED_SESSION_STORAGE_KEY, text(session([5, 0, 0])));
    expect(port.applyAccount(text(session([40, 0, 0])))).toBe(true);
    expect(deps.accountMode.current).toBe(true);
    expect(deps.retire).toHaveBeenCalledOnce();
    const setSaveFailed = vi.fn();
    persistCertifiedSession(deps.latest.current, deps.accountMode.current, setSaveFailed);
    expect(stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text(session([5, 0, 0])));
    expect(setSaveFailed).not.toHaveBeenCalled();
    // Guest sessions keep the unchanged storage behaviour.
    persistCertifiedSession(deps.latest.current, false, setSaveFailed);
    expect(stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text(session([40, 0, 0])));
  });

  it("showGuest reloads the guest key through the startup path, including quarantine", () => {
    const { port, deps, published } = fixture();
    port.applyAccount(text(session([40, 0, 0])));
    stored.set(CERTIFIED_SESSION_STORAGE_KEY, text(session([7, 0, 0])));
    port.showGuest();
    expect(deps.accountMode.current).toBe(false);
    expect(published.at(-1)?.session).toEqual(session([7, 0, 0]));
    expect(port.readGuest()).toBe(text(session([7, 0, 0])));

    stored.set(CERTIFIED_SESSION_STORAGE_KEY, "{broken");
    port.showGuest();
    expect(published.at(-1)).toMatchObject({
      storageBlocked: true,
      blockedStorageText: "{broken",
      actionError: "invalid_certified_calculator_storage",
    });
    expect(port.readGuest()).toBeNull();
    expect(readGuestCertifiedSessionText()).toBeNull();
  });

  it("reconciles a session from an older snapshot and starts empty accounts on the current one", () => {
    const snapshot = buildCertifiedSupplySnapshot({
      asOf: "2026-09-30T03:00:00Z",
      revision: "current",
      sourceHash: "a".repeat(64),
      soloPeriods: [],
      collaborationPeriods: [],
    });
    const { port, deps } = fixture(snapshot);
    expect(port.applyAccount(text(session([40, 0, 0], "older")))).toBe(true);
    expect(deps.updateSession).toHaveBeenCalledOnce();
    const empty = port.emptyText();
    expect(JSON.parse(empty)).toMatchObject({ snapshotRevision: "current", stock: [0, 0, 0] });
    expect(port.isEmpty(empty)).toBe(true);
    expect(validateCertifiedSessionText(empty)).toBe(empty);
  });
});
