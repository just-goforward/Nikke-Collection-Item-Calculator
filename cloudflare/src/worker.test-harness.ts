import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "./worker";

const REQUEST_URL = "https://worker.test/api/events";

type SiteverifyOutcome = { body?: object; status?: number } | Error;
type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerEnv = Parameters<WorkerFetch>[1];
type WorkerRequest = Parameters<WorkerFetch>[0];

export class WorkerTestHarness {
  readonly env: Partial<WorkerEnv> = {
    ADMIN_TOKEN: "test-admin-token",
    ALLOWED_ORIGINS: "https://test.example",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
  };

  siteverifyContentTypes: Array<string | null> = [];
  siteverifyForms: URLSearchParams[] = [];

  #database: D1Database | null = null;
  #guardDatabase: D1Database | null = null;

  get database() {
    if (!this.#database) throw new Error("Worker test database is not initialized.");
    return this.#database;
  }

  async setup() {
    await reset();
    this.#database = env.DB;
    this.#guardDatabase = env.USAGE_GUARD_DB;
    this.env.DB = env.DB;
    this.env.USAGE_GUARD_DB = env.USAGE_GUARD_DB;
    this.env.ADMIN_TOKEN = "test-admin-token";
    this.env.ALLOWED_ORIGINS = "https://test.example";
    await this.applySchema();
    await this.applyGuardState();
    this.mockSiteverify({ body: { success: true } });
  }

  async teardown() {
    vi.unstubAllGlobals();
    delete this.env.ALLOWED_ORIGINS;
    delete this.env.ADMIN_TOKEN;
    this.#database = null;
    this.#guardDatabase = null;
  }

  async submit(payload: object) {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    const ctx = createExecutionContext();
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
    await waitOnExecutionContext(ctx);
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

  async fetchHealth(origin: string | null = "https://test.example") {
    if (!worker.fetch) throw new Error("Worker fetch handler is not defined.");
    const headers = new Headers();
    if (origin) headers.set("Origin", origin);
    return worker.fetch(
      new Request("https://worker.test/api/health", { headers }) as WorkerRequest,
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

  async setGuardAction(action: string) {
    if (!this.#guardDatabase) throw new Error("Usage Guard test database is not initialized.");
    const now = Date.now();
    await this.#guardDatabase
      .prepare(
        `UPDATE usage_guard_state
         SET action = ?, observed_at = ?, period_start = ?, period_end = ?
         WHERE singleton_id = 1`,
      )
      .bind(
        action,
        new Date(now).toISOString(),
        new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
        new Date(now + 29 * 24 * 60 * 60 * 1_000).toISOString(),
      )
      .run();
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

  private async applyGuardState() {
    if (!this.#guardDatabase) throw new Error("Usage Guard test database is not initialized.");
    await this.#guardDatabase
      .prepare(
        `CREATE TABLE IF NOT EXISTS usage_guard_state (
           singleton_id INTEGER PRIMARY KEY,
           action TEXT NOT NULL,
           observed_at TEXT NOT NULL,
           period_start TEXT NOT NULL,
           period_end TEXT NOT NULL,
           evidence_hash TEXT NOT NULL
         )`,
      )
      .run();
    const now = Date.now();
    await this.#guardDatabase
      .prepare(
        `INSERT OR REPLACE INTO usage_guard_state (
           singleton_id, action, observed_at, period_start, period_end, evidence_hash
         ) VALUES (1, 'normal', ?, ?, ?, ?)`,
      )
      .bind(
        new Date(now).toISOString(),
        new Date(now - 24 * 60 * 60 * 1_000).toISOString(),
        new Date(now + 29 * 24 * 60 * 60 * 1_000).toISOString(),
        "a".repeat(64),
      )
      .run();
  }

  private workerEnv(): WorkerEnv {
    const db = this.env.DB;
    if (!db) throw new Error("Worker test DB binding is not initialized.");
    return {
      DB: db,
      USAGE_GUARD_DB: this.env.USAGE_GUARD_DB ?? db,
      EVENT_RATE_LIMITER: this.env.EVENT_RATE_LIMITER ?? env.EVENT_RATE_LIMITER,
      ALLOWED_ORIGINS: this.env.ALLOWED_ORIGINS ?? "",
      ADMIN_TOKEN: this.env.ADMIN_TOKEN ?? "",
      TURNSTILE_SECRET_KEY: this.env.TURNSTILE_SECRET_KEY ?? "",
    };
  }

  private executionContext(): ExecutionContext {
    return createExecutionContext();
  }
}
