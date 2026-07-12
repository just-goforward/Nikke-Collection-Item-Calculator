import { Miniflare } from "miniflare";
import { vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "./worker";

const REQUEST_URL = "https://worker.test/api/events";

type SiteverifyOutcome = { body?: object; status?: number } | Error;
type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerEnv = Parameters<WorkerFetch>[1];
type WorkerRequest = Parameters<WorkerFetch>[0];

class TestSpan {
  get isTraced() {
    return false;
  }

  setAttribute() {}

  end() {}
}

const testSpan: Span = new TestSpan();
const testTracing: Tracing = {
  enterSpan(_name, callback, ...args) {
    return callback(testSpan, ...args);
  },
  startActiveSpan(_name, callback, ...args) {
    return callback(testSpan, ...args);
  },
  Span: TestSpan,
};
const testExports = {} as Cloudflare.Exports;

function makeExecutionContext(waitUntil: (promise: Promise<unknown>) => void = () => {}) {
  return {
    exports: testExports,
    props: {},
    tracing: testTracing,
    waitUntil,
    passThroughOnException() {},
  } satisfies ExecutionContext;
}

export class WorkerTestHarness {
  readonly env: Partial<WorkerEnv> = {
    ADMIN_TOKEN: "test-admin-token",
    ALLOWED_ORIGINS: "https://test.example",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    RATE_LIMIT_SECRET: "test-rate-limit-secret",
  };

  siteverifyContentTypes: Array<string | null> = [];
  siteverifyForms: URLSearchParams[] = [];

  #database: D1Database | null = null;
  #miniflare: Miniflare | null = null;

  get database() {
    if (!this.#database) throw new Error("Worker test database is not initialized.");
    return this.#database;
  }

  async setup() {
    this.#miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('unused'); } };",
      compatibilityDate: "2026-05-05",
      d1Databases: ["DB"],
    });
    const database = await this.#miniflare.getD1Database("DB");
    if (!database) throw new Error("Worker test DB binding is not available.");
    this.#database = database;
    this.env.DB = database;
    this.env.ADMIN_TOKEN = "test-admin-token";
    this.env.ALLOWED_ORIGINS = "https://test.example";
    this.env.RATE_LIMIT_SECRET = "test-rate-limit-secret";
    await this.applySchema();
    this.mockSiteverify({ body: { success: true } });
  }

  async teardown() {
    vi.unstubAllGlobals();
    delete this.env.ALLOWED_ORIGINS;
    delete this.env.ADMIN_TOKEN;
    await this.#miniflare?.dispose();
    this.#database = null;
    this.#miniflare = null;
  }

  async submit(payload: object) {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    const pending: Promise<unknown>[] = [];
    const ctx = makeExecutionContext((promise) => pending.push(promise));
    const request = new Request(REQUEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://test.example",
        "CF-Connecting-IP": "203.0.113.1",
      },
      body: JSON.stringify(payload),
    }) as WorkerRequest;
    const response = await worker.fetch(request, this.workerEnv(), ctx);
    await Promise.allSettled(pending);
    return response;
  }

  async fetchStats(origin: string | null = "https://test.example", extraHeaders?: HeadersInit) {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    const headers = new Headers(extraHeaders);
    if (origin) headers.set("Origin", origin);
    return worker.fetch(
      new Request("https://worker.test/api/stats", {
        headers,
      }) as WorkerRequest,
      this.workerEnv(),
      this.executionContext(),
    );
  }

  async fetchAdminSolverDiagnostics(
    token: string | null = "test-admin-token",
    origin: string | null = "https://test.example",
  ) {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    const headers = new Headers();
    if (origin) headers.set("Origin", origin);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return worker.fetch(
      new Request("https://worker.test/api/admin/solver-diagnostics", { headers }) as WorkerRequest,
      this.workerEnv(),
      this.executionContext(),
    );
  }

  async preflight(origin: string) {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    return worker.fetch(
      new Request(REQUEST_URL, {
        method: "OPTIONS",
        headers: { Origin: origin },
      }) as WorkerRequest,
      this.workerEnv(),
      this.executionContext(),
    );
  }

  async countRows(table: string) {
    const result = await this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
      count: number;
    }>();
    return Number(result?.count || 0);
  }

  mockSiteverify(...outcomes: SiteverifyOutcome[]): void {
    let index = 0;
    this.siteverifyForms = [];
    this.siteverifyContentTypes = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        if (body instanceof URLSearchParams) this.siteverifyForms.push(body);
        this.siteverifyContentTypes.push(new Headers(init?.headers).get("Content-Type"));
        const outcome = outcomes[Math.min(index, outcomes.length - 1)];
        index += 1;
        if (outcome instanceof Error) throw outcome;
        return new Response(JSON.stringify(outcome?.body || { success: true }), {
          status: outcome?.status || 200,
        });
      }),
    );
  }

  siteverifyForm(index: number): URLSearchParams {
    const form = this.siteverifyForms[index];
    if (!form) throw new Error(`Missing siteverify form at index ${index}.`);
    return form;
  }

  private async applySchema() {
    const statements = schemaSql
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await this.database.prepare(statement).run();
    }
  }

  private workerEnv(): WorkerEnv {
    const db = this.env.DB;
    if (!db) throw new Error("Worker test DB binding is not initialized.");
    return {
      DB: db,
      ALLOWED_ORIGINS: this.env.ALLOWED_ORIGINS ?? "",
      ADMIN_TOKEN: this.env.ADMIN_TOKEN ?? "",
      TURNSTILE_SECRET_KEY: this.env.TURNSTILE_SECRET_KEY ?? "",
      RATE_LIMIT_SECRET: this.env.RATE_LIMIT_SECRET ?? "",
    };
  }

  private executionContext(): ExecutionContext {
    return makeExecutionContext();
  }
}
