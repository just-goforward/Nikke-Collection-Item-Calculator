import { describe, expect, it, vi } from "vitest";
import { createGithubAppJwt, dispatchProposalWorkflow, GithubDispatchError } from "./github-app";
import type { DispatcherEnv } from "./types";

describe("GitHub App workflow dispatch", () => {
  it("mints one installation token and dispatches only the fixed workflow and ref", async () => {
    const pem = await generatePrivateKeyPem();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app/installations/789012/access_tokens")) {
        expect(new Headers(init?.headers).get("authorization")).toMatch(
          /^Bearer [^.]+\.[^.]+\.[^.]+$/,
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["Nikke-Collection-Item-Calculator"],
          permissions: { actions: "write" },
        });
        return Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 });
      }
      expect(url).toBe(
        "https://api.github.com/repos/just-goforward/Nikke-Collection-Item-Calculator/actions/workflows/forecast-proposal.yml/dispatches",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ghs_test_installation_token_1234567890",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        ref: "main",
        inputs: {
          target_environment: "staging",
          bootstrap_solo_history: "false",
          dispatch_id: `fd-${"a".repeat(32)}`,
          dispatch_mode: "work",
        },
      });
      return new Response(null, { status: 204 });
    });

    await expect(
      dispatchProposalWorkflow(
        dispatcherEnv(pem),
        { dispatchId: `fd-${"a".repeat(32)}`, mode: "work" },
        { nowMs: Date.parse("2026-08-31T00:00:00Z"), fetchImpl },
      ),
    ).resolves.toEqual({ status: 204 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the bounded GitHub App JWT lifetime", async () => {
    const nowMs = Date.parse("2026-08-31T00:00:00Z");
    const jwt = await createGithubAppJwt("123456", await generatePrivateKeyPem(), nowMs);
    const payload = JSON.parse(decodeBase64Url(jwt.split(".")[1] ?? "")) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(payload).toEqual({
      iat: Math.floor(nowMs / 1_000) - 60,
      exp: Math.floor(nowMs / 1_000) + 9 * 60,
      iss: "123456",
    });
  });

  it("accepts the PKCS#1 RSA private-key format issued by GitHub Apps", async () => {
    await expect(
      createGithubAppJwt("123456", await generatePrivateKeyPem("pkcs1"), Date.now()),
    ).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  });

  it("classifies GitHub 5xx as retryable without exposing its body", async () => {
    const pem = await generatePrivateKeyPem();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 }),
      )
      .mockResolvedValueOnce(new Response("sensitive upstream body", { status: 500 }));

    const error = await dispatchProposalWorkflow(
      dispatcherEnv(pem),
      { dispatchId: `fd-${"b".repeat(32)}`, mode: "smoke" },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubDispatchError);
    expect(error).toMatchObject({
      message: "github_workflow_dispatch_500",
      retryable: true,
      status: 500,
    });
    expect(String(error)).not.toContain("sensitive upstream body");
  });

  it.each([
    [401, false],
    [403, false],
    [404, false],
    [422, false],
    [429, true],
  ])("classifies workflow dispatch HTTP %i with retryable=%s", async (status, retryable) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ token: "ghs_test_installation_token_1234567890" }, { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(null, { status }));
    const error = await dispatchProposalWorkflow(
      dispatcherEnv(await generatePrivateKeyPem()),
      { dispatchId: `fd-${"c".repeat(32)}`, mode: "work" },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: `github_workflow_dispatch_${status}`,
      retryable,
      status,
    });
  });

  it("classifies a network rejection as retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network details"));
    const error = await dispatchProposalWorkflow(
      dispatcherEnv(await generatePrivateKeyPem()),
      { dispatchId: `fd-${"d".repeat(32)}`, mode: "work" },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "github_network", retryable: true, status: null });
    expect(String(error)).not.toContain("network details");
  });
});

function dispatcherEnv(privateKey: string) {
  return {
    ENVIRONMENT: "staging",
    DEPLOY_SHA: "test-sha",
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "789012",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    DISCORD_BOT_TOKEN: "test-discord-token",
    DISCORD_CHANNEL_ID: "123456789012345678",
  } as DispatcherEnv;
}

async function generatePrivateKeyPem(format: "pkcs8" | "pkcs1" = "pkcs8") {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const bytes = format === "pkcs1" ? extractPkcs1(pkcs8) : pkcs8;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  const label = format === "pkcs1" ? "RSA PRIVATE KEY" : "PRIVATE KEY";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function extractPkcs1(pkcs8: Uint8Array) {
  const outer = readDer(pkcs8, 0, 0x30);
  const version = readDer(pkcs8, outer.bodyOffset, 0x02);
  const algorithm = readDer(pkcs8, version.endOffset, 0x30);
  const privateKey = readDer(pkcs8, algorithm.endOffset, 0x04);
  return pkcs8.slice(privateKey.bodyOffset, privateKey.endOffset);
}

function readDer(bytes: Uint8Array, offset: number, expectedTag: number) {
  if (bytes[offset] !== expectedTag) throw new Error("Unexpected DER tag.");
  const firstLength = bytes[offset + 1];
  if (firstLength === undefined) throw new Error("Missing DER length.");
  if (firstLength < 0x80) {
    const bodyOffset = offset + 2;
    return { bodyOffset, endOffset: bodyOffset + firstLength };
  }
  const lengthBytes = firstLength & 0x7f;
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    const byte = bytes[offset + 2 + index];
    if (byte === undefined) throw new Error("Missing DER length byte.");
    length = (length << 8) | byte;
  }
  const bodyOffset = offset + 2 + lengthBytes;
  return { bodyOffset, endOffset: bodyOffset + length };
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}
