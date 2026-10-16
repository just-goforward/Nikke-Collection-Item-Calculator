import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_DOMAIN,
  canonicalPublicationJson,
  POINTER_DOMAIN,
  publicationHash,
  signPublication,
} from "../shared/forecastPublication";
import { type PublicationBytes, publicationBytesHash } from "../shared/forecastPublicationBytes";
import { createForecastEndpoint, type ForecastEnv } from "../site-worker/src/forecast";
import gateway from "../site-worker/src/worker";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let now = Date.parse("2026-10-07T03:00:00Z");
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // This tests the sealed-byte transport, not publisher candidate admission (covered
  // by M4 and runtimeForecast.test.ts). No candidate derivation happens in this path.
  const candidate = { z: "한글", candidateId: "forecast-read-only-fixture", a: 1 };
  const hash = await publicationHash(candidate);
  const authorization = await signPublication(
    {
      domain: ARTIFACT_DOMAIN,
      environment: "staging",
      keyId: "test",
      candidateId: candidate.candidateId,
      contentHash: hash,
    },
    keys.privateKey,
  );
  const active = await signPublication(
    {
      domain: POINTER_DOMAIN,
      environment: "staging",
      keyId: "test",
      sequence: 1,
      mode: "active",
      candidateId: candidate.candidateId,
      contentHash: hash,
      operationId: "12345",
      issuedAt: now,
    },
    keys.privateKey,
  );
  db.exec(`
    CREATE TABLE forecast_runtime_active(singleton INTEGER PRIMARY KEY,environment TEXT,sequence INTEGER,candidate_id TEXT,signed_pointer_json TEXT);
    CREATE TABLE forecast_runtime_approvals(candidate_id TEXT PRIMARY KEY,environment TEXT,payload_hash TEXT,key_id TEXT,artifact_signature TEXT);
    CREATE TABLE forecast_candidates(candidate_id TEXT PRIMARY KEY,payload_json TEXT);
    CREATE TABLE forecast_runtime_versions(candidate_id TEXT PRIMARY KEY,payload_hash TEXT);
    CREATE TABLE usage_guard_state(singleton_id INTEGER PRIMARY KEY,action TEXT,observed_at TEXT,period_start TEXT,period_end TEXT,evidence_hash TEXT);
  `);
  db.prepare("INSERT INTO forecast_runtime_active VALUES(1,'staging',1,?,?)").run(
    candidate.candidateId,
    JSON.stringify(active),
  );
  db.prepare("INSERT INTO forecast_runtime_approvals VALUES(?,'staging',?,'test',?)").run(
    candidate.candidateId,
    hash,
    authorization.signature,
  );
  db.prepare("INSERT INTO forecast_candidates VALUES(?,?)").run(
    candidate.candidateId,
    JSON.stringify(candidate),
  );
  db.prepare("INSERT INTO forecast_runtime_versions VALUES(?,?)").run(candidate.candidateId, hash);
  db.prepare(
    "INSERT INTO usage_guard_state VALUES(1,'normal',?,'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z',?)",
  ).run(new Date(now).toISOString(), "a".repeat(64));
  db.exec("PRAGMA query_only=ON");
  const sql: string[] = [];
  const reader = {
    withSession: vi.fn((constraint: "first-primary") => {
      expect(constraint).toBe("first-primary");
      return {
        prepare(query: string) {
          sql.push(query);
          return {
            async first<T>() {
              return (db.prepare(query).get() ?? null) as T | null;
            },
          };
        },
      };
    }),
  };
  let requests = 0;
  const limiter = { limit: vi.fn(async () => ({ success: ++requests <= 60 })) };
  const env: ForecastEnv = {
    SITE_ENV: "staging",
    FORECAST_RUNTIME_MODE: "enabled",
    FORECAST_DB: reader,
    USAGE_GUARD_DB: reader,
    FORECAST_RATE_LIMITER: limiter,
  };
  const endpoint = createForecastEndpoint(() => now);
  return {
    db,
    env,
    sql,
    reader,
    limiter,
    candidate,
    hash,
    active,
    advance(ms: number) {
      now += ms;
      requests = 0;
    },
    change(query: string) {
      db.exec("PRAGMA query_only=OFF");
      db.exec(query);
      db.exec("PRAGMA query_only=ON");
    },
    async off() {
      const pointer = await signPublication(
        {
          ...active.statement,
          sequence: 2,
          mode: "off",
          candidateId: null,
          contentHash: null,
        },
        keys.privateKey,
      );
      db.exec("PRAGMA query_only=OFF");
      db.prepare(
        "UPDATE forecast_runtime_active SET sequence=2,candidate_id=NULL,signed_pointer_json=?",
      ).run(JSON.stringify(pointer));
      db.exec("PRAGMA query_only=ON");
    },
    get(path = "/api/forecast", method = "GET") {
      return endpoint(
        new Request(`https://staging.nikkecollection.com${path}`, {
          method,
          headers: { "CF-Connecting-IP": "192.0.2.1" },
        }),
        env,
      );
    },
  };
}

describe("site forecast read-only consumer", () => {
  it.each([
    ["UPDATE usage_guard_state SET action='hard_stop'", 1],
    ["UPDATE forecast_runtime_active SET sequence=0,signed_pointer_json=NULL", 2],
    ["DELETE FROM forecast_runtime_active", 2],
  ] as const)("caches failure without sliding or repeated D1 reads: %s", async (change, reads) => {
    const f = await fixture();
    f.change(change);
    expect((await f.get()).status).toBe(503);
    expect(f.sql).toHaveLength(reads);
    for (let i = 0; i < 10; i++) expect((await f.get("/api/forecast/version")).status).toBe(503);
    f.advance(59_999);
    expect((await f.get()).status).toBe(503);
    expect(f.sql).toHaveLength(reads);
    f.advance(1);
    expect((await f.get()).status).toBe(503);
    expect(f.sql).toHaveLength(reads * 2);
  });
  it("serves canonical signed bytes from a genuinely query-only SQLite connection", async () => {
    const f = await fixture();
    expect(() => f.db.prepare("DELETE FROM forecast_runtime_active").run()).toThrow();
    const response = await f.get("/api/forecast?sql=DELETE%20FROM%20forecast_candidates");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as PublicationBytes & { remainingMs: number };
    expect(body.pointer.statement).toBe(canonicalPublicationJson(f.active.statement));
    expect(body.artifact?.candidate).toBe(canonicalPublicationJson(f.candidate));
    expect(await publicationBytesHash(body.artifact!.candidate)).toBe(f.hash);
    expect(body.remainingMs).toBe(60_000);
    expect(f.sql).toHaveLength(2);
    for (const query of f.sql) {
      expect(query.trim()).toMatch(/^SELECT /);
      expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|PRAGMA|CREATE|DROP|ALTER)\b/i);
    }
    expect(f.db.prepare("SELECT count(*) AS n FROM forecast_candidates").get()?.["n"]).toBe(1);
  });

  it("shares a non-sliding 60 s primary-read deadline across version and artifact reads", async () => {
    const f = await fixture();
    expect((await f.get()).status).toBe(200);
    await f.off();
    f.advance(59_999);
    const version = (await (await f.get("/api/forecast/version")).json()) as Record<
      string,
      unknown
    >;
    expect(version["remainingMs"]).toBe(1);
    expect(version).not.toHaveProperty("artifact");
    expect(f.sql).toHaveLength(2);
    f.advance(1);
    const body = (await (await f.get()).json()) as PublicationBytes;
    expect(JSON.parse(body.pointer.statement)).toMatchObject({ sequence: 2, mode: "off" });
    expect(body.artifact).toBeNull();
    expect(f.sql).toHaveLength(4);
  });

  it.each([
    "DELETE FROM forecast_runtime_active",
    "DROP TABLE forecast_runtime_active",
    "UPDATE usage_guard_state SET action='hard_stop'",
    "UPDATE usage_guard_state SET observed_at='2026-10-06T00:00:00Z'",
    "UPDATE forecast_candidates SET payload_json='{}'",
    "UPDATE forecast_runtime_active SET environment='production'",
  ])("fails closed after cache expiry: %s", async (change) => {
    const f = await fixture();
    expect((await f.get()).status).toBe(200);
    f.change(change);
    f.advance(60_000);
    expect((await f.get()).status).toBe(503);
  });

  it("enforces the IP limiter on cache hits as well as misses without extra D1 reads", async () => {
    const f = await fixture();
    for (let i = 0; i < 60; i++) expect((await f.get("/api/forecast/version")).status).toBe(200);
    expect((await f.get()).status).toBe(429);
    expect(f.sql).toHaveLength(2);
    expect(f.limiter.limit).toHaveBeenLastCalledWith({ key: "192.0.2.1" });
  });

  it("rejects mutation methods and production before touching either database", async () => {
    const f = await fixture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await f.get("/api/forecast", method)).status).toBe(405);
    f.env.SITE_ENV = "production";
    expect((await f.get()).status).toBe(503);
    expect(f.sql).toHaveLength(0);
  });

  it("routes only the exact public paths; no admin or query-selected environment", async () => {
    const f = await fixture();
    const env = { ...f.env, ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
    for (const path of ["/api/forecast/admin", "/api/forecast/activate"]) {
      expect((await gateway.fetch(new Request(`https://site.invalid${path}`), env)).status).toBe(
        404,
      );
    }
    expect(f.sql).toHaveLength(0);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });
});
