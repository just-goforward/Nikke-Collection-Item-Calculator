import { describe, expect, it, vi } from "vitest";
import { dispatchPagesVerification } from "./dispatch-pages-verification";

const HEAD = "a".repeat(40);
const RUN_URL = "https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/1";
const INPUT = {
  repository: "just-goforward/Nikke-Collection-Item-Calculator",
  branch: `automation/supply-forecast/forecast-${"b".repeat(24)}`,
  headSha: HEAD,
  token: "token-with-at-least-twenty-characters",
  apiUrl: "https://api.example.test",
};

describe("dispatchPagesVerification", () => {
  it("waits for the exact remote SHA and the registered workflow run", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: { sha: "c".repeat(40) } }))
      .mockResolvedValueOnce(Response.json({ object: { sha: HEAD } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        Response.json({
          workflow_runs: [
            {
              event: "workflow_dispatch",
              head_sha: HEAD,
              html_url: RUN_URL,
            },
          ],
        }),
      );
    const sleep = vi.fn(async () => undefined);

    await expect(dispatchPagesVerification(INPUT, { fetchImpl, sleep })).resolves.toBe(RUN_URL);

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ ref: INPUT.branch }),
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rejects branches outside the two automation namespaces", async () => {
    await expect(dispatchPagesVerification({ ...INPUT, branch: "main" })).rejects.toThrow(
      "invalid_pages_verification_branch",
    );
  });

  it("accepts API v2026's 200 and waits for that run on the expected commit", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: { sha: HEAD } }))
      .mockResolvedValueOnce(Response.json({ workflow_run_id: 1, html_url: RUN_URL }))
      .mockResolvedValueOnce(
        Response.json({
          workflow_runs: [
            { id: 2, event: "workflow_dispatch", head_sha: HEAD, html_url: `${RUN_URL}2` },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflow_runs: [{ id: 1, event: "workflow_dispatch", head_sha: HEAD, html_url: RUN_URL }],
        }),
      );
    const sleep = vi.fn(async () => undefined);
    await expect(dispatchPagesVerification(INPUT, { fetchImpl, sleep })).resolves.toBe(RUN_URL);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "1", 0, -1, 1.5])("rejects a malformed accepted run ID %s", async (id) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: { sha: HEAD } }))
      .mockResolvedValueOnce(Response.json({ workflow_run_id: id }));
    await expect(dispatchPagesVerification(INPUT, { fetchImpl })).rejects.toThrow(
      "pages_verification_dispatch_invalid_run",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a non-retryable ref response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));

    await expect(dispatchPagesVerification(INPUT, { fetchImpl })).rejects.toThrow(
      "pages_verification_ref_probe_failed:403",
    );
  });

  it("does not accept a workflow run for a different commit", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/git/ref/")) return Response.json({ object: { sha: HEAD } });
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return Response.json({
        workflow_runs: [
          {
            event: "workflow_dispatch",
            head_sha: "d".repeat(40),
            html_url: "https://github.com/example/actions/runs/2",
          },
        ],
      });
    });

    await expect(
      dispatchPagesVerification(INPUT, { fetchImpl, sleep: async () => undefined }),
    ).rejects.toThrow("pages_verification_run_not_registered");
  });
});
