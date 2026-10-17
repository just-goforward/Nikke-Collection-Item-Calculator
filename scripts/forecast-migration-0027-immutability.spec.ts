import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("rejects every processor alternate UNIQUE replacement with valid parent rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        resolve(import.meta.dirname, "../forecast-collector/fixtures/schema-v27-test.sql"),
        "utf8",
      ),
    );
    db.exec("PRAGMA foreign_keys=ON");
    const run = "11111111-1111-1111-1111-111111111111";
    const other = "22222222-2222-2222-2222-222222222222";
    const hash = "a".repeat(64);
    const insert = (table: string, row: Record<string, string | number>) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row)
            .map(() => "?")
            .join(",")})`,
        )
        .run(...Object.values(row));
    insert("source_processor_runs", {
      token: run,
      epoch: 1,
      kind: "normal",
      started_at: "t",
      lease_until: "u",
    });
    insert("source_processor_incidents", {
      origin_run_token: run,
      epoch: 1,
      scope: "detail",
      outcome: "failure",
      error_code: "fixture",
      created_at: "t",
    });
    const common = { source: "naver-board-48", item_id: "1", source_generation: 1 };
    const reservation = {
      ...common,
      recovery_run_token: run,
      request_id: "request",
      claim_token: run,
      metadata_json: "{}",
      item_json: "{}",
      body_hash: hash,
      revision_hash: hash,
      semantic_hash: hash,
      request_profile_hash: hash,
      created_at: "t",
      lease_until: "u",
    };
    insert("source_processor_control_reservations", reservation);
    const probe = {
      ...common,
      proof_id: run,
      recovery_run_token: run,
      request_id: "request",
      payload_hash: hash,
      origin_run_token: run,
      item_claim_token: run,
      metadata_json: "{}",
      failed_error_code: "fixture",
      response_hash: hash,
      request_profile_hash: hash,
      comparable: 1,
      created_at: "t",
    };
    insert("source_processor_recovery_probes", probe);
    const exception = {
      ...common,
      exception_id: run,
      proof_id: run,
      recovery_run_token: run,
      request_id: "request",
      payload_hash: hash,
      review_generation: 1,
      review_id: "review",
      metadata_json: "{}",
      item_claim_token: run,
      mode: "force",
      reason: "fixture",
      force_confirmed: 1,
      created_at: "t",
    };
    insert("source_processor_item_exceptions", exception);
    const cases = [
      ["source_processor_control_reservations", { ...reservation, request_id: "new" }],
      ["source_processor_recovery_probes", { ...probe, proof_id: other }],
      ["source_processor_item_exceptions", { ...exception, exception_id: other, item_id: "new" }],
      [
        "source_processor_item_exceptions",
        { ...exception, exception_id: other, request_id: "new" },
      ],
    ] as const;
    for (const [table, row] of cases) {
      const before = db.prepare(`SELECT * FROM ${table}`).all();
      expect(() => insert(table, row)).toThrow("source_processor_evidence_immutable");
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
