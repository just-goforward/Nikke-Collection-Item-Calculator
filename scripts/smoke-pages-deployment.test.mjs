import assert from "node:assert/strict";
import test from "node:test";
import { checkedFetch } from "./smoke-pages-deployment.mjs";

const options = {
  origin: "https://nikkecollection.com",
  revision: "a".repeat(40),
  hostingTarget: "pages",
};

test("Pages smoke never requests Worker-directed or unapproved hosts", async () => {
  const fetchImpl = () => assert.fail("must not fetch");
  await assert.rejects(
    checkedFetch(options.origin, "text/html", {
      ...options,
      fetchImpl,
      hostingTarget: "worker",
    }),
    /Worker hosting/,
  );
  await assert.rejects(
    checkedFetch("https://other.example", "text/html", {
      ...options,
      fetchImpl,
    }),
    /unapproved host/,
  );
  await assert.rejects(
    checkedFetch("https://site.workers.dev", "text/html", {
      ...options,
      origin: "https://site.workers.dev",
      fetchImpl,
    }),
    /Worker host/,
  );
});

test("Pages smoke refuses redirects without following them", async () => {
  await assert.rejects(
    checkedFetch(options.origin, "text/html", {
      ...options,
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return new Response(null, { status: 302, headers: { Location: "https://worker.example" } });
      },
    }),
    /unexpected redirect/,
  );
});

test("Pages smoke accepts the explicitly approved host", async () => {
  const response = await checkedFetch(options.origin, "text/html", {
    ...options,
    fetchImpl: async () => new Response("page", { headers: { "Content-Type": "text/html" } }),
  });
  assert.equal(await response.text(), "page");
});
