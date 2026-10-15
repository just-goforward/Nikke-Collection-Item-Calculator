import { describe, expect, it } from "vitest";
import { pagesPublicationPolicy } from "./site-hosting-policy";

describe("Pages publication policy", () => {
  it.each([undefined, "", "pages"])("preserves legacy publication for %s", (target) => {
    expect(pagesPublicationPolicy(target)).toEqual({
      publishPages: true,
      smokePages: true,
      retainRollbackArtifact: true,
    });
  });

  it("retains verification artifacts but never publishes or smokes Pages in Worker mode", () => {
    expect(pagesPublicationPolicy("worker")).toEqual({
      publishPages: false,
      smokePages: false,
      retainRollbackArtifact: true,
    });
  });

  it.each(["Worker", " workers ", "false", "unknown"])("fails closed for %s", (target) => {
    expect(() => pagesPublicationPolicy(target)).toThrow("SITE_HOSTING_TARGET");
  });
});
