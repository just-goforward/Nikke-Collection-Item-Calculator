import { describe, expect, it } from "vitest";

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
});
