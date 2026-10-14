import type { ApiError } from "./contracts";
import type { PersonalEnv } from "./types";

/** M1 is fail-closed storage scaffolding: no OAuth or private-data HTTP routes yet. */
export default {
  async fetch(request: Request, env: PersonalEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    let status = 501;
    let error: ApiError["error"] = "not_implemented";
    if (request.method === "GET" && path === "/v1/statistics") {
      const fence = await env.PUBLIC_AGGREGATE_DB.prepare(
        "SELECT blocked FROM privacy_fence WHERE singleton = 1",
      ).first<{ blocked: number }>();
      if (!fence || fence.blocked) {
        status = 503;
        error = "privacy_fenced";
      }
    }
    return Response.json({ error } satisfies ApiError, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  },
};
