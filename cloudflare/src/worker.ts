/// <reference types="@cloudflare/workers-types" />

import type { WorkerEnv } from "./env";
import { handleEvent } from "./event-submission";
import { handleOptions, jsonResponse } from "./http";
import { HttpError } from "./http-error";
import { handleStats } from "./stats-read";

const worker: ExportedHandler<WorkerEnv> = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return handleOptions(request, env);
      if (url.pathname === "/api/stats" && request.method === "GET")
        return await handleStats(request, env);
      if (url.pathname === "/api/events" && request.method === "POST")
        return await handleEvent(request, env, ctx);
      return jsonResponse(request, env, { error: "not_found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal_error";
      const body: { error: string; retryable?: boolean } = {
        error: message || "internal_error",
      };
      if (error instanceof HttpError && typeof error.retryable === "boolean") {
        body.retryable = error.retryable;
      }
      return jsonResponse(request, env, body, status);
    }
  },
};

export default worker;
