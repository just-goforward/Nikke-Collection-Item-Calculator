import { describe, expect, it } from "vitest";
import { handleOptions, isAllowedOrigin, jsonResponse } from "./http";

describe("http helpers", () => {
  const env = { ALLOWED_ORIGINS: "https://allowed.example, https://other.example/" };

  it("allows configured origins after normalization", () => {
    const request = new Request("https://worker.test/api/events", {
      headers: { Origin: "https://other.example" },
    });

    expect(isAllowedOrigin(request, env)).toBe(true);
  });

  it("rejects disallowed preflight origins", () => {
    const request = new Request("https://worker.test/api/events", {
      method: "OPTIONS",
      headers: { Origin: "https://blocked.example" },
    });

    expect(handleOptions(request, env).status).toBe(403);
  });

  it("adds CORS and security headers to JSON responses", async () => {
    const request = new Request("https://worker.test/api/events", {
      headers: { Origin: "https://allowed.example" },
    });
    const response = jsonResponse(request, env, { ok: true }, 201, "max-age=60");

    expect(response.status).toBe(201);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
    expect(response.headers.get("Cache-Control")).toBe("max-age=60");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
