// Local only: node site-worker/personal-data-smoke.ts
// Fake service bindings; no D1, provider calls, credentials, or remote resources.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { Miniflare, Response } from "miniflare";

const origin = "https://staging.nikkecollection.com";
const callback = "/auth/callback/google";
const csp =
  "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; frame-ancestors 'none'";
const bridge = '<script nonce="fixture">fetch("/auth/callback/google",{method:"POST"})</script>';
const parameters = "?code=fixture&state=fixture";
let revision = 0;
const seen: {
  service: string;
  path: string;
  method: string;
  cookie: string | null;
  authorization: string | null;
  body: string;
}[] = [];
const source = await readFile(new URL("./src/worker.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const mf = new Miniflare({
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  workers: [
    {
      config: {
        name: "site-personal-smoke",
        compatibilityDate: "2026-10-13",
        manifest: {
          mainModule: "worker.js",
          modules: { "worker.js": { type: "esm", contents: code } },
        },
        env: {
          PERSONAL_DATA: {
            type: "fetcher",
            async handler(request) {
              const path = new URL(request.url).pathname;
              const body = await request.text();
              seen.push({
                service: "personal",
                path,
                method: request.method,
                cookie: request.headers.get("Cookie"),
                authorization: request.headers.get("Authorization"),
                body,
              });
              if (path === "/auth/login/google") {
                assert.equal(request.method, "POST");
                assert.equal(body, "{}");
                return Response.json(
                  {
                    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
                  },
                  {
                    headers: {
                      "Set-Cookie": "fixture-flow=1; Secure; HttpOnly; SameSite=Lax; Path=/",
                    },
                  },
                );
              }
              if (path === callback) {
                assert.equal(request.headers.get("Cookie"), "fixture-flow=1");
                if (request.method === "GET") {
                  assert.equal(new URL(request.url).search, parameters);
                  return new Response(bridge, {
                    headers: { "Content-Type": "text/html", "Content-Security-Policy": csp },
                  });
                }
                assert.equal(request.headers.get("Origin"), origin);
                assert.equal(request.headers.get("Sec-Fetch-Site"), "same-origin");
                assert.deepEqual(JSON.parse(body), { parameters });
                return Response.json(
                  { redirect: "/" },
                  {
                    headers: {
                      "Set-Cookie": "fixture-session=1; Secure; HttpOnly; SameSite=Lax; Path=/",
                    },
                  },
                );
              }
              if (path === "/v1/workspace") {
                assert.equal(request.headers.get("Cookie"), "fixture-session=1");
                if (request.method === "PUT") {
                  assert.deepEqual(JSON.parse(body), {
                    opId: "fixture-save",
                    baseRevision: 0,
                    document: { items: [] },
                    action: "save",
                  });
                  revision = 1;
                }
                return Response.json({ revision, document: { items: [] } });
              }
              return new Response(
                path === callback && request.method === "GET" ? bridge : "personal",
                {
                  headers: {
                    "Content-Type":
                      path === callback && request.method === "GET" ? "text/html" : "text/plain",
                    "Content-Security-Policy": csp,
                    "Set-Cookie": "fixture-session=1; Secure; HttpOnly; SameSite=Lax; Path=/",
                    "Cache-Control": "public, max-age=3600",
                  },
                },
              );
            },
          },
          STATS: {
            type: "fetcher",
            async handler(request) {
              seen.push({
                service: "stats",
                path: new URL(request.url).pathname,
                method: request.method,
                cookie: request.headers.get("Cookie"),
                authorization: request.headers.get("Authorization"),
                body: await request.text(),
              });
              return new Response("stats", { headers: { "Set-Cookie": "must-be-removed=1" } });
            },
          },
          ASSETS: { type: "fetcher", handler: () => new Response("static-only", { status: 404 }) },
        },
      },
      dev: {
        outboundService: {
          type: "fetcher",
          handler: () => {
            throw new Error("Unexpected network access");
          },
        },
      },
    },
  ],
});

try {
  const postHeaders = {
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  };
  const login = await mf.dispatchFetch(`${origin}/auth/login/google`, {
    method: "POST",
    headers: postHeaders,
    body: "{}",
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
  });
  const flowCookie = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  const getBridge = await mf.dispatchFetch(`${origin}${callback}${parameters}`, {
    headers: { Cookie: flowCookie, "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(getBridge.status, 200);
  assert.equal(getBridge.headers.get("Content-Security-Policy"), csp);
  assert.equal(await getBridge.text(), bridge);
  const complete = await mf.dispatchFetch(`${origin}${callback}`, {
    method: "POST",
    headers: { ...postHeaders, Cookie: flowCookie },
    body: JSON.stringify({ parameters }),
  });
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), { redirect: "/" });
  const sessionCookie = complete.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  assert.equal(sessionCookie, "fixture-session=1");
  const workspace = await mf.dispatchFetch(`${origin}/v1/workspace`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(workspace.status, 200);
  assert.deepEqual(await workspace.json(), { revision: 0, document: { items: [] } });
  const saved = await mf.dispatchFetch(`${origin}/v1/workspace`, {
    method: "PUT",
    headers: { ...postHeaders, Cookie: sessionCookie },
    body: JSON.stringify({
      opId: "fixture-save",
      baseRevision: 0,
      document: { items: [] },
      action: "save",
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { revision: 1, document: { items: [] } });
  for (const response of [login, getBridge, complete, workspace, saved]) {
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  }
  const publicRelease = await mf.dispatchFetch(`${origin}/v1/statistics`, {
    headers: { Cookie: sessionCookie, Authorization: "Bearer fixture" },
  });
  assert.equal(publicRelease.status, 200);
  assert.equal(await publicRelease.text(), "personal");
  assert.equal(publicRelease.headers.get("Cache-Control"), "no-store");
  assert.equal(publicRelease.headers.has("Set-Cookie"), false);
  assert.equal(seen.at(-1)?.cookie, null);
  assert.equal(seen.at(-1)?.authorization, null);
  const stats = await mf.dispatchFetch(`${origin}/api/stats`, {
    headers: { Cookie: "fixture=1", Authorization: "Bearer fixture" },
  });
  assert.equal(await stats.text(), "stats");
  assert.equal(stats.headers.has("Set-Cookie"), false);
  assert.equal(seen.at(-1)?.cookie, null);
  assert.equal(seen.at(-1)?.authorization, null);
  const count = seen.length;
  const rejected = await mf.dispatchFetch(`${origin}${callback}`, {
    method: "POST",
    headers: { Origin: "https://other.invalid" },
    body: "{}",
  });
  assert.equal(rejected.status, 403);
  assert.equal((await mf.dispatchFetch(`${origin}/v1/workspace`, { method: "POST" })).status, 405);
  assert.equal((await mf.dispatchFetch(`${origin}/api/admin/solver-diagnostics`)).status, 404);
  assert.equal((await mf.dispatchFetch(`${origin}/v1/unknown`)).status, 404);
  assert.equal(await (await mf.dispatchFetch(`${origin}/unknown-page`)).text(), "static-only");
  assert.equal(seen.length, count);
  assert.deepEqual(
    seen.slice(0, 5).map(({ path, method }) => [path, method]),
    [
      ["/auth/login/google", "POST"],
      [callback, "GET"],
      [callback, "POST"],
      ["/v1/workspace", "GET"],
      ["/v1/workspace", "PUT"],
    ],
  );
  console.log(
    "PASS: login → callback GET bridge → same-origin POST → session cookie → workspace GET/PUT; CSP, credential isolation, and default-deny/static-only boundaries (local workerd).",
  );
} finally {
  await mf.dispose();
}
