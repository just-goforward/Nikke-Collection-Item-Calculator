import { describe, expect, it } from "vitest";
import { normalizeDiagnosticToken, normalizeSourceHost, normalizeStrategy } from "./normalization";

describe("normalization helpers", () => {
  it("normalizes known source host values and strips www", () => {
    expect(normalizeSourceHost(" WWW.Example.COM ")).toBe("example.com");
    expect(normalizeSourceHost("direct")).toBe("direct");
    expect(normalizeSourceHost("same-site")).toBe("same-site");
  });

  it("rejects malformed source hosts", () => {
    expect(normalizeSourceHost("bad..host")).toBe("unknown");
    expect(normalizeSourceHost(".example.com")).toBe("unknown");
    expect(normalizeSourceHost("example.com/path")).toBe("unknown");
    expect(normalizeSourceHost("a".repeat(81))).toBe("unknown");
    expect(normalizeSourceHost(null)).toBe("unknown");
  });

  it("normalizes strategies to the accepted storage vocabulary", () => {
    expect(normalizeStrategy("single")).toBe("single");
    expect(normalizeStrategy("supply")).toBe("supply");
    expect(normalizeStrategy("rust-min-ef")).toBe("unknown");
  });

  it("keeps diagnostic tokens short and log-safe", () => {
    expect(normalizeDiagnosticToken("phase3_rust-min.ef")).toBe("phase3_rust-min.ef");
    expect(normalizeDiagnosticToken("bad token")).toBe("unknown");
    expect(normalizeDiagnosticToken("a".repeat(65))).toBe("unknown");
  });
});
