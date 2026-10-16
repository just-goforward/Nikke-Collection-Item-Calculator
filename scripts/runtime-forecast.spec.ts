import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertCertifiedRuntimeSupplySnapshot } from "../shared/certifiedSupply";
import { publicationWire } from "../shared/forecast-publication/consumer-wire";
import {
  ARTIFACT_DOMAIN,
  encodeBase64,
  POINTER_DOMAIN,
  type PointerStatement,
  type PublicationEnvelope,
  publicationHash,
  signPublication,
  verifyPublication,
} from "../shared/forecastPublication";
import { verifyPublicationBytes } from "../shared/forecastPublicationBytes";
import { buildV3SupplyForecastCandidate } from "../shared/supplyForecastCandidate";
import registry from "../shared/supplyForecasts.json";
import { createCertifiedSession } from "../src/certifiedUi/session";
import { useCertifiedCalculatorPreparation } from "../src/certifiedUi/useCertifiedCalculatorPreparation";
import { assertTrustedCertifiedForecast } from "../src/lib/certifiedForecastTrust";
import {
  createRuntimeForecastClient,
  type RuntimeForecastStatus,
  runtimeForecast,
} from "../src/lib/runtimeForecast";

const pinned = vi.hoisted(() => ({
  enabled: true,
  trust: { environment: "staging" as const, keyId: "", publicKeyBase64: "" },
}));
const hooks = vi.hoisted(() => ({ effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: EffectCallback) => {
    hooks.effects.push(effect);
  },
}));
vi.mock("../src/lib/runtimeForecastConfig", () => ({
  runtimeForecastConfig: pinned,
  get runtimeForecastEnabled() {
    return pinned.enabled;
  },
}));

const asOf = "2026-10-07T03:00:00.000Z";
let active: PublicationEnvelope;
let off: PublicationEnvelope;
let rollback: PublicationEnvelope;
let signingKey: CryptoKey;
let trust: Parameters<typeof createRuntimeForecastClient>[0]["trust"];

beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = keys.privateKey;
  trust = {
    environment: "staging",
    keyId: "throwaway-test",
    publicKeyBase64: encodeBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    ),
  };
  Object.assign(pinned.trust, trust);
  const entry = registry.forecasts.find((item) => item.id === registry.approvedForecastId)!;
  const snapshot = assertCertifiedRuntimeSupplySnapshot(Reflect.get(entry, "certifiedSnapshot"));
  snapshot.revision = "runtime-approved-fixture";
  const periods = snapshot.soloRounds
    .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
    .slice(0, 3)
    .map((round) => ({
      effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
      effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
      scheduleStatus: "estimated" as const,
    }));
  const primary = periods[0]!;
  const candidate = buildV3SupplyForecastCandidate({
    candidateId: "forecast-runtime-consumer-fixture",
    forecastId: entry.id,
    generatedAt: snapshot.asOf,
    sourceStatus: "x_unavailable",
    dispatchPolicyId: "dispatch-policy-v1",
    schedule: {
      status: "estimated",
      cadenceDays: null,
      soloStart: primary.effectiveFrom,
      soloEnd: primary.effectiveUntil,
      soloPeriods: periods,
      collaborationPeriods: [],
    },
    sourceEvidence: entry.sourceEvidence,
    warnings: [],
    certifiedSnapshot: snapshot,
  });
  const statement = {
    environment: trust.environment,
    keyId: trust.keyId,
    candidateId: candidate.candidateId,
    contentHash: await publicationHash(candidate),
  };
  const pointer: PointerStatement = {
    ...statement,
    domain: POINTER_DOMAIN,
    sequence: 1,
    mode: "active" as const,
    operationId: "12345",
    issuedAt: Date.parse(asOf),
  };
  active = {
    pointer: await signPublication(pointer, keys.privateKey),
    artifact: {
      candidate,
      authorization: await signPublication(
        { ...statement, domain: ARTIFACT_DOMAIN },
        keys.privateKey,
      ),
    },
  };
  off = {
    pointer: await signPublication(
      { ...pointer, sequence: 2, mode: "off", candidateId: null, contentHash: null },
      keys.privateKey,
    ),
    artifact: null,
  };
  rollback = {
    ...active,
    pointer: await signPublication({ ...pointer, sequence: 3 }, keys.privateKey),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup(initial = active) {
  let envelope: unknown = initial;
  let remainingMs = 60_000;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const value = publicationWire(envelope as PublicationEnvelope);
    return Response.json({
      pointer: value?.pointer,
      ...(url === "/api/forecast" ? { artifact: value?.artifact } : {}),
      remainingMs,
    });
  });
  const client = createRuntimeForecastClient({ enabled: true, trust, fetch: fetcher });
  return {
    client,
    fetcher,
    set(value: unknown) {
      envelope = value;
    },
    ttl(value: number) {
      remainingMs = value;
    },
  };
}

describe("signed runtime forecast consumer admission", () => {
  it("rejects incompatible rules even when both signatures and the content hash are authentic", async () => {
    const envelope = structuredClone(active);
    if (!envelope.artifact) throw new Error("missing_fixture");
    Reflect.set(envelope.artifact.candidate, "rulesVersion", "future-rules");
    const contentHash = await publicationHash(envelope.artifact.candidate);
    envelope.pointer = await signPublication(
      { ...envelope.pointer.statement, contentHash },
      signingKey,
    );
    envelope.artifact.authorization = await signPublication(
      {
        ...envelope.artifact.authorization.statement,
        contentHash,
      },
      signingKey,
    );
    await expect(
      verifyPublicationBytes(publicationWire(envelope), { ...trust, minimumSequence: 0 }),
    ).rejects.toThrow("publication_unsupported_rules");
  });

  it("revalidates an expired entry without discarding the verified artifact or announcing failure", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { client, fetcher } = setup();
    expect(await client.acquire(asOf)).not.toBeNull();
    now = 59_999;
    expect(client.peek(asOf)).not.toBeNull();
    now = 60_000;
    expect(client.peek(asOf)).not.toBeNull();
    await client.refresh();
    const statuses: RuntimeForecastStatus[] = [];
    client.subscribe((status) => statuses.push(status))();
    expect(statuses).toEqual(["active"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/forecast")).toHaveLength(1);
  });
  it("binds an unbundled runtime snapshot to its proof, never to request-declared identity", async () => {
    const { client } = setup();
    const selected = await client.acquire(asOf);
    if (!selected) throw new Error("missing_runtime_fixture");
    await expect(assertTrustedCertifiedForecast(selected.snapshot, () => {})).rejects.toThrow(
      "certified_forecast_not_approved",
    );
    await expect(
      assertTrustedCertifiedForecast(selected.snapshot, () => {}, selected.publication),
    ).resolves.toMatchObject({
      snapshotRevision: "runtime-approved-fixture",
    });
    const forged = {
      ...selected.snapshot,
      provenance: [...selected.snapshot.provenance, "unsigned-provenance"],
    };
    await expect(
      assertTrustedCertifiedForecast(forged, () => {}, selected.publication),
    ).rejects.toThrow("certified_forecast_not_approved");
  });
  it("accepts exactly the existing server's signed statements without browser canonicalization", async () => {
    for (const envelope of [active, off, rollback]) {
      const authority = { ...trust, minimumSequence: 0 };
      await expect(verifyPublication(envelope, authority)).resolves.toEqual(envelope);
      const verified = await verifyPublicationBytes(publicationWire(envelope), authority);
      expect(verified.pointer).toEqual(envelope.pointer.statement);
      expect(verified.snapshot).toEqual(envelope.artifact?.candidate.certifiedSnapshot ?? null);
    }
    for (const part of ["pointer", "artifact", "candidate"] as const) {
      const wire = publicationWire(active);
      if (!wire.artifact) throw new Error("missing_fixture");
      if (part === "pointer") wire.pointer.statement += " ";
      if (part === "artifact") wire.artifact.authorization.statement += " ";
      if (part === "candidate") wire.artifact.candidate += " ";
      await expect(
        verifyPublicationBytes(wire, { ...trust, minimumSequence: 0 }),
      ).rejects.toThrow();
    }
  });
  it("validates the full artifact, then refreshes unchanged identity through the small endpoint", async () => {
    const { client, fetcher } = setup();
    const first = await client.acquire(asOf);
    expect(first?.publication).toEqual(publicationWire(active));
    expect(first?.snapshot.sourceHash).toBe(
      active.artifact!.candidate.certifiedSnapshot!.sourceHash,
    );
    expect(await client.acquire(asOf)).toEqual(first);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/forecast/version",
      "/api/forecast",
      "/api/forecast/version",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toBeUndefined();
    }
  });
});

describe("runtime activation and replay protection", () => {
  it("does not replace an acquired snapshot on off, rollback, failure, or a later check", async () => {
    const { client, set } = setup();
    const acquired = await client.acquire(asOf);
    const original = structuredClone(acquired);
    set(off);
    expect(await client.acquire(asOf)).toBeNull();
    set(rollback);
    expect(JSON.parse((await client.acquire(asOf))!.publication.pointer.statement).sequence).toBe(
      3,
    );
    set(active);
    expect(await client.acquire(asOf)).toBeNull();
    expect(acquired).toEqual(original);
    set(rollback);
    expect(JSON.parse((await client.acquire(asOf))!.publication.pointer.statement).sequence).toBe(
      3,
    );
  });

  it("R2-002 remembers authenticated off seq 2 despite an inconsistent artifact, rejecting replay and equal seq", async () => {
    const { client, set } = setup();
    const statuses: RuntimeForecastStatus[] = [];
    const unsubscribe = client.subscribe((status) => statuses.push(status));
    expect(await client.acquire(asOf)).not.toBeNull();
    set({ ...off, artifact: active.artifact });
    expect(await client.acquire(asOf)).toBeNull();
    set(active);
    expect(await client.acquire(asOf)).toBeNull();
    set(off);
    expect(await client.acquire(asOf)).toBeNull();
    expect(statuses.at(-1)).toBe("unavailable");
    set(rollback);
    expect(await client.acquire(asOf)).not.toBeNull();
    unsubscribe();
  });

  it.each(["signature", "fields"])(
    "does not advance the watermark for an invalid pointer %s",
    async (failure) => {
      const { client, set } = setup();
      expect(await client.acquire(asOf)).not.toBeNull();
      const bad = structuredClone(active);
      bad.pointer.statement.sequence = 99;
      if (failure === "fields")
        bad.pointer = await signPublication(
          {
            ...bad.pointer.statement,
            environment: "production",
          },
          signingKey,
        );
      set(bad);
      expect(await client.acquire(asOf)).toBeNull();
      set(active);
      expect(await client.acquire(asOf)).not.toBeNull();
    },
  );

  it.each(["pointer", "signature", "hash", "rules", "missing", "environment"])(
    "falls back on %s failure and never serves the last successful entry on error",
    async (kind) => {
      const { client, set } = setup();
      expect(await client.acquire(asOf)).not.toBeNull();
      const bad = structuredClone(active);
      if (kind === "pointer") bad.pointer.statement.sequence++;
      if (kind === "environment") bad.pointer.statement.environment = "production";
      if (["signature", "hash", "rules"].includes(kind)) {
        if (!bad.artifact) throw new Error("missing_fixture");
        // A genuinely new signed hash forces artifact admission instead of reusing
        // the previous immutable artifact. The pointer itself MUST authenticate.
        bad.artifact.candidate.warnings.push("new-artifact");
        if (kind === "rules") Reflect.set(bad.artifact.candidate, "rulesVersion", "unsupported");
        const contentHash = await publicationHash(bad.artifact.candidate);
        bad.pointer = await signPublication(
          { ...bad.pointer.statement, sequence: 2, contentHash },
          signingKey,
        );
        bad.artifact.authorization = await signPublication(
          {
            ...bad.artifact.authorization.statement,
            contentHash,
          },
          signingKey,
        );
        if (kind === "signature") bad.artifact.authorization.signature = "AAAA";
        if (kind === "hash") bad.artifact.candidate.warnings.push("tampered-after-signing");
        const error =
          kind === "signature"
            ? "publication_invalid_signature"
            : kind === "hash"
              ? "publication_artifact_mismatch"
              : "publication_unsupported_rules";
        await expect(
          verifyPublicationBytes(publicationWire(bad), { ...trust, minimumSequence: 0 }),
        ).rejects.toThrow(error);
      }
      set(kind === "missing" ? {} : bad);
      expect(await client.acquire(asOf)).toBeNull();
    },
  );

  it.each(["expiry", "mismatch"])(
    "retries a %s race once within the same check",
    async (failure) => {
      const { client, fetcher } = setup();
      const wire = publicationWire(active);
      if (failure === "expiry")
        fetcher
          .mockResolvedValueOnce(
            Response.json({
              ...wire,
              remainingMs: 0,
            }),
          )
          .mockResolvedValueOnce(Response.json({ ...wire, remainingMs: 0 }));
      else
        fetcher
          .mockResolvedValueOnce(Response.json({ ...wire, remainingMs: 60_000 }))
          .mockResolvedValueOnce(
            Response.json({ ...publicationWire(rollback), remainingMs: 60_000 }),
          );
      expect(await client.acquire(asOf)).not.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );

  it("bounds repeated freshness failures to two attempts", async () => {
    const { client, fetcher, ttl } = setup();
    ttl(0);
    expect(await client.acquire(asOf)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("runtime transport failure fallback", () => {
  it.each([0, -1, 60_001, null])("rejects an expired/invalid server deadline %s", async (ttl) => {
    const { client, ttl: setTtl } = setup();
    setTtl(ttl as number);
    expect(await client.acquire(asOf)).toBeNull();
  });

  it("fails closed when WebCrypto Ed25519 is unsupported", async () => {
    const { client } = setup();
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("NotSupportedError"));
    expect(await client.acquire(asOf)).toBeNull();
  });

  it("uses bundled data on a guard/D1/HTTP failure or network rejection", async () => {
    const { client, fetcher } = setup();
    for (const status of [429, 503, 404]) {
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      expect(await client.acquire(asOf)).toBeNull();
    }
    fetcher.mockRejectedValueOnce(new Error("network"));
    expect(await client.acquire(asOf)).toBeNull();
  });

  it("bounds a stalled request and never adopts its late completion", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = createRuntimeForecastClient({ enabled: true, trust, fetch: fetcher });
    const result = client.acquire(asOf);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("does not contact the network unless staging is explicitly enabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createRuntimeForecastClient({ enabled: false, trust, fetch: fetcher });
    expect(await client.acquire(asOf)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("runtime forecast visibility checks", () => {
  it("R1-01/R1-14 keeps preparation stable and polls only every five visible minutes", async () => {
    vi.stubEnv("VITE_FORECAST_RUNTIME", "staging");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(asOf));
    const { fetcher } = setup();
    const client = createRuntimeForecastClient({
      enabled: true,
      trust,
      fetch: fetcher,
      now: Date.now,
    });
    vi.spyOn(runtimeForecast, "peek").mockImplementation(client.peek);
    vi.spyOn(runtimeForecast, "watch").mockImplementation(client.watch);
    const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", visibility);
    vi.stubGlobal("window", { setInterval, clearInterval });
    hooks.effects = [];
    const session = createCertifiedSession(
      "runtime-approved-fixture",
      { grade: "SR", level: 0, exp: 0 },
      [0, 0, 0],
    );
    const latest = {
      current: { session, correction: null, storageBlocked: false, modalBatch: null },
    } as Parameters<typeof useCertifiedCalculatorPreparation>[1];
    const preparation: Parameters<typeof useCertifiedCalculatorPreparation>[0] = {
      snapshot: null,
      setSnapshot: vi.fn(),
      prepareError: null,
      setPrepareError: vi.fn(),
      snapshotRef: { current: null },
    };
    const pendingRecompute = { current: session as typeof session | null };
    const retire = vi.fn(() => {
      pendingRecompute.current = null;
    });
    useCertifiedCalculatorPreparation(preparation, latest, retire, vi.fn(), { current: false });
    const dispose = hooks.effects[0]?.();
    try {
      await import("../src/lib/runtimeForecast");
      await client.refresh();
      expect(preparation.snapshotRef.current?.revision).toBe(session.snapshotRevision);
      retire.mockClear();
      vi.mocked(preparation.setSnapshot).mockClear();
      pendingRecompute.current = session;
      const statuses: RuntimeForecastStatus[] = [];
      let completed = () => {};
      const periodicCheck = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const unsubscribe = client.subscribe((status) => {
        statuses.push(status);
        if (statuses.length === 2) completed();
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (let minute = 0; minute < 5; minute++) {
        await vi.advanceTimersByTimeAsync(60_000);
        if (minute < 4) expect(fetcher).toHaveBeenCalledTimes(2);
        expect(preparation.snapshotRef.current?.revision).toBe(session.snapshotRevision);
      }
      await periodicCheck;
      expect(fetcher).toHaveBeenCalledTimes(3);
      visibility.visibilityState = "hidden";
      visibility.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(fetcher).toHaveBeenCalledTimes(3);
      visibility.visibilityState = "visible";
      visibility.dispatchEvent(new Event("visibilitychange"));
      await client.refresh();
      expect(fetcher).toHaveBeenCalledTimes(4);
      // Explicit pre-calculation acquisition is never blocked by the cadence or visibility.
      visibility.visibilityState = "hidden";
      await client.acquire(asOf);
      expect(fetcher).toHaveBeenCalledTimes(5);
      unsubscribe();
      expect(retire).not.toHaveBeenCalled();
      expect(pendingRecompute.current).toBe(session);
      expect(statuses).not.toContain("unavailable");
      expect(fetcher.mock.calls.filter(([url]) => url === "/api/forecast")).toHaveLength(1);
      for (const [value] of vi.mocked(preparation.setSnapshot).mock.calls)
        expect(value).toMatchObject({ revision: session.snapshotRevision });
    } finally {
      if (typeof dispose === "function") dispose();
      vi.unstubAllGlobals();
    }
  });
  it("checks on load, every five visible minutes, resume and each acquisition", async () => {
    vi.useFakeTimers();
    const { client, fetcher } = setup(off);
    const visibility = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const statuses: RuntimeForecastStatus[] = [];
    const dispose = client.watch(visibility, (status) => statuses.push(status));
    await client.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await client.refresh();
    expect(fetcher).toHaveBeenCalledTimes(3);
    visibility.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    visibility.visibilityState = "visible";
    visibility.dispatchEvent(new Event("visibilitychange"));
    await client.refresh();
    expect(fetcher).toHaveBeenCalledTimes(4);
    await client.acquire(asOf);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(statuses).toContain("off");
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

import type { EffectCallback } from "react";
