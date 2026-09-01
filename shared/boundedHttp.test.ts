import { describe, expect, it, vi } from "vitest";
import { readBoundedBytes, readBoundedJson } from "./boundedHttp";

describe("bounded HTTP readers", () => {
  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const response = new Response("small", { headers: { "content-length": "11" } });
    await expect(readBoundedBytes(response, 10, "body_oversize")).rejects.toThrow("body_oversize");
  });

  it("accepts a chunked body exactly on the boundary", async () => {
    const response = chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    await expect(readBoundedBytes(response, 4, "body_oversize")).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("cancels a chunked stream immediately after it crosses the boundary", async () => {
    const cancel = vi.fn();
    const response = chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], cancel);

    await expect(readBoundedBytes(response, 4, "body_oversize")).rejects.toThrow("body_oversize");
    expect(cancel).toHaveBeenCalledWith("body_oversize");
  });

  it("distinguishes invalid JSON from a byte-limit failure", async () => {
    await expect(readBoundedJson(new Response("{"), 10, "request_body")).rejects.toThrow(
      "request_body_json",
    );
  });
});

function chunkedResponse(chunks: Uint8Array[], cancel = vi.fn()) {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    }),
  );
}
