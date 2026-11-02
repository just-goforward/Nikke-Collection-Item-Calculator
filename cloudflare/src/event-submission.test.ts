import { describe, expect, it, vi } from "vitest";

import { readJsonPayload } from "./event-submission";

function streamedRequest(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Request("https://worker.test/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  });
}

describe("readJsonPayload", () => {
  it("parses a chunked JSON body without Content-Length", async () => {
    const request = streamedRequest(['{"version":', "1}"]);

    await expect(readJsonPayload(request)).resolves.toEqual({ version: 1 });
  });

  it("stops a chunked body as soon as its encoded size exceeds the limit", async () => {
    const request = streamedRequest(['{"value":"', "가".repeat(1_400), '"}']);

    await expect(readJsonPayload(request)).rejects.toMatchObject({
      message: "payload_too_large",
      status: 413,
    });
  });

  it("reports a missing body as invalid_json and a cancel rejection as a warning", async () => {
    await expect(
      readJsonPayload(new Request("https://worker.test/api/events")),
    ).rejects.toMatchObject({ message: "invalid_json", status: 400 });

    const encoder = new TextEncoder();
    let sent = false;
    const cancelError = new Error("SENTINEL_cancel_secret");
    const cancel = vi.fn(async () => {
      throw cancelError;
    });
    const request = new Request("https://worker.test/api/events", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(encoder.encode(`{"value":"${"a".repeat(5_000)}"}`));
        },
        cancel,
      }),
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // The 413 for the oversized body stays authoritative even though cancel rejects.
    await expect(readJsonPayload(request)).rejects.toMatchObject({
      message: "payload_too_large",
      status: 413,
    });
    expect(cancel).toHaveBeenCalledWith("payload_too_large");
    const logged = warning.mock.calls.map(([line]) => JSON.parse(String(line)));
    // A plain Error with a foreign message is the fixed category, never its name or text.
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "stream_cancel_failed", error: "unexpected" }),
    );
    // The thrown message itself never reaches the log line.
    expect(JSON.stringify(warning.mock.calls)).not.toContain("SENTINEL_cancel_secret");
    warning.mockRestore();
  });
});
