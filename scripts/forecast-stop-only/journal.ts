import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { z } from "zod";
import type { Journal, Receipt } from "./types.ts";

const receipt = z
  .object({
    attempt: z
      .object({
        requestId: z.uuid(),
        role: z.enum(["collector", "dispatcher"]),
        script: z.string(),
        versionId: z.uuid(),
        epoch: z.number().int().positive(),
        startedAt: z.iso.datetime(),
        approvalRef: z.string(),
        message: z.string(),
      })
      .strict(),
    state: z.enum(["prepared", "submitted", "resolved", "unknown", "not_submitted"]),
    deploymentId: z.uuid().optional(),
  })
  .strict();

const marker = z.object({ chain: z.literal("incomplete"), reason: z.string() }).strict();
const entry = z.union([receipt, marker]);
const origin = z.discriminatedUnion("kind", [
  z.object({ format: z.literal(1), kind: z.literal("incomplete"), reason: z.string() }).strict(),
  z
    .object({
      format: z.literal(1),
      kind: z.literal("baseline"),
      approvalRef: z.string().trim().min(1).max(500),
      sourceRef: z.string().trim().min(1).max(500),
      checkpoint: z
        .object({
          bytes: z.number().int().nonnegative().max(4_194_304),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
]);
function journalBytes(path: string) {
  if (!existsSync(path)) throw new Error("request_evidence_missing");
  const bytes = readFileSync(path);
  if (bytes.length > 4_194_304) throw new Error("request_evidence_too_large");
  return bytes;
}
function entries(bytes: Buffer) {
  return bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => entry.parse(JSON.parse(line)));
}
function evidence(path: string): Journal["baselineEvidence"] {
  try {
    const bytes = journalBytes(path),
      records = entries(bytes);
    if (records.some((r) => "chain" in r)) return "incomplete";
    if (!existsSync(`${path}.origin.json`)) return "unavailable";
    const originBytes = readFileSync(`${path}.origin.json`);
    if (originBytes.length > 4096) return "invalid";
    const meta = origin.parse(JSON.parse(originBytes.toString("utf8")));
    if (meta.kind === "incomplete") return "incomplete";
    const prefix = bytes.subarray(0, meta.checkpoint.bytes);
    if (
      prefix.length !== meta.checkpoint.bytes ||
      (prefix.length > 0 && prefix.at(-1) !== 10) ||
      createHash("sha256").update(prefix).digest("hex") !== meta.checkpoint.sha256
    )
      return "invalid";
    return "provided";
  } catch {
    return existsSync(path) ? "invalid" : "unavailable";
  }
}
function appendDurably(path: string, value: unknown) {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fileJournal(
  path: string,
  baselineEvidence: Journal["baselineEvidence"] = "unavailable",
): Journal {
  let tainted = false;
  const journal: Journal = {
    get baselineEvidence() {
      if (tainted) return "incomplete";
      const stored = evidence(path);
      if (stored === "provided" && baselineEvidence !== "provided") return "unavailable";
      return stored;
    },
    set baselineEvidence(value) {
      if (value !== "provided") baselineEvidence = value;
    },
    async read() {
      return entries(journalBytes(path)).filter((r): r is Receipt => !("chain" in r));
    },
    async markIncomplete(cause) {
      tainted = true;
      // No checkpoint issuer or complete toggle exists here. Persist the origin
      // before opening a new receipt file and retain an append-only marker.
      if (!existsSync(`${path}.origin.json`)) {
        const fd = openSync(`${path}.origin.json`, "wx", 0o600);
        try {
          writeSync(fd, JSON.stringify({ format: 1, kind: "incomplete", reason: cause }) + "\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      appendDurably(path, marker.parse({ chain: "incomplete", reason: cause }));
    },
    async append(value) {
      if (journal.baselineEvidence !== "provided")
        await journal.markIncomplete("baseline_incomplete");
      appendDurably(path, receipt.parse(value));
    },
  };
  return journal;
}
