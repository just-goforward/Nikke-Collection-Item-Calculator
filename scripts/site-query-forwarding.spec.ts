import { expect, test } from "vitest";
import worker from "../site-worker/src/worker";

test("stats gateway preserves query strings for upstream rejection", async () => {
  const url = "https://nikkecollection.com/api/stats?x=a%20b&x=2";
  let forwarded = "";
  const response = await worker.fetch(new Request(url), {
    ASSETS: { fetch: async () => new Response("unexpected asset fallback", { status: 500 }) },
    STATS: {
      fetch: async (request) => {
        forwarded = request.url;
        return Response.json({ error: "unexpected_query" }, { status: 400 });
      },
    },
  });
  expect(forwarded).toBe(url);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "unexpected_query" });
});
