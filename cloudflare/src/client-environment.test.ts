import { describe, expect, it } from "vitest";
import { clientEnvironment } from "./client-environment";

describe("clientEnvironment", () => {
  it("uses client hints before user-agent fallbacks when available", () => {
    const request = new Request("https://worker.test/api/events", {
      headers: {
        "Sec-CH-UA": '"Not A(Brand";v="99", "Google Chrome";v="136", "Chromium";v="136"',
        "Sec-CH-UA-Platform": '"Android"',
        "Sec-CH-UA-Mobile": "?1",
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36",
      },
    });

    expect(clientEnvironment(request)).toEqual({
      browser: "Chrome",
      browserMajor: "136",
      os: "Android",
      osMajor: "14",
      deviceType: "mobile",
    });
  });

  it("falls back to unknown values when headers are absent", () => {
    const request = new Request("https://worker.test/api/events");

    expect(clientEnvironment(request)).toEqual({
      browser: "Unknown",
      browserMajor: "unknown",
      os: "Unknown",
      osMajor: "unknown",
      deviceType: "unknown",
    });
  });
});
