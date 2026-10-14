import { describe, expect, it } from "vitest";
import { transactionDone } from "./workspaceStore";

describe("transactionDone (N-A9)", () => {
  it("rejects with the error that aborted the transaction, never with null", async () => {
    const transaction: Pick<IDBTransaction, "oncomplete" | "onerror" | "onabort"> & {
      error: DOMException | null;
    } = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    const done = transactionDone(transaction, "result");
    const refused = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    // A failed request's error event reaches the transaction before the abort sets its error.
    if (transaction.onerror) Reflect.apply(transaction.onerror, transaction, [new Event("error")]);
    transaction.error = refused;
    if (transaction.onabort) Reflect.apply(transaction.onabort, transaction, [new Event("abort")]);
    await expect(done).rejects.toBe(refused);
  });
});
