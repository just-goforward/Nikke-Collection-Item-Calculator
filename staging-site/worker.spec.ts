import { describe, expect, it, vi } from "vitest";
import worker, { stagingDocumentUrl } from "./worker";

describe("staging site boundary", () => {
  it("redirects document requests to the staging statistics environment", () => {
    const redirect = stagingDocumentUrl(
      new Request("https://collection-kit-calculator-staging.example/en?foo=1", {
        headers: { accept: "text/html" },
      }),
    );

    expect(redirect?.pathname).toBe("/en");
    expect(redirect?.searchParams.get("foo")).toBe("1");
    expect(redirect?.searchParams.get("statsEnv")).toBe("staging");
  });

  it("serves assets directly after the staging environment is selected", async () => {
    const fetchAsset = vi.fn().mockResolvedValue(new Response("asset"));
    const request = new Request(
      "https://collection-kit-calculator-staging.example/?statsEnv=staging",
      { headers: { "sec-fetch-dest": "document" } },
    );

    const response = await worker.fetch(request, { ASSETS: { fetch: fetchAsset } });

    expect(await response.text()).toBe("asset");
    expect(fetchAsset).toHaveBeenCalledWith(request);
  });
});
