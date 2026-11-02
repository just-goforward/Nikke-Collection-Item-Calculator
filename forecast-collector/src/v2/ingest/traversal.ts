import { IngestFailure, type Metadata } from "./client";
import type { Stream } from "./schedule";

export type Boundary = { createdAt: string; feedIds: string[] };
export type Scan = {
  kind: "new" | "edit";
  boundary: Boundary;
  page: number;
  hits: Metadata[];
  seenBoundaryIds: string[];
  lastCreatedAt: string | null;
  status: "running" | "held" | "completed";
  reason: string | null;
};
export function startScan(boundary: Boundary, kind: Scan["kind"] = "new"): Scan {
  if (!Number.isFinite(Date.parse(boundary.createdAt))) throw new IngestFailure("cutoff");
  return {
    kind,
    boundary,
    page: 0,
    hits: [],
    seenBoundaryIds: [],
    lastCreatedAt: null,
    status: "running",
    reason: null,
  };
}

// Pure transition: callers persist the returned scan and hits together under the
// lease fence. A failed fetch must not call this function or advance its cursor.
export function advanceScan(scan: Scan, rows: Metadata[], stream: Stream): Scan {
  if (scan.status !== "running") throw new IngestFailure("scan_not_running");
  const size = stream === "G" ? 10 : 30;
  if (rows.length > size) throw new IngestFailure("page_size");
  const boundaryIds = new Set(scan.seenBoundaryIds);
  const hits = new Map(scan.hits.map((hit) => [hit.feedId, hit]));
  const { previous, crossed } = collectPage(scan, rows, boundaryIds, hits);
  const page = scan.page + 1;
  const sourceCount = (rows as Metadata[] & { sourceCount?: number }).sourceCount ?? rows.length;
  const ended = crossed || sourceCount < size;
  const missingBoundary =
    scan.kind === "new" && scan.boundary.feedIds.some((id) => !boundaryIds.has(id));
  const recovery =
    missingBoundary && ended
      ? rows.find((row) => row.createdAt < scan.boundary.createdAt)
      : undefined;
  const status = scanStatus(ended, missingBoundary && !recovery, page);
  return {
    ...scan,
    page,
    hits: [...hits.values()],
    seenBoundaryIds: [...boundaryIds],
    lastCreatedAt: previous,
    status,
    boundary: recovery
      ? { createdAt: recovery.createdAt, feedIds: [recovery.feedId] }
      : scan.boundary,
    reason: scanReason(Boolean(recovery), status, ended),
  };
}

function scanStatus(ended: boolean, missing: boolean, page: number): Scan["status"] {
  if (ended) return missing ? "held" : "completed";
  return page >= 4 ? "held" : "running";
}

function scanReason(recovered: boolean, status: Scan["status"], ended: boolean) {
  if (recovered) return "boundary_reseeded";
  if (status !== "held") return null;
  return ended ? "missing_boundary" : "page_cap";
}

function collectPage(
  scan: Scan,
  rows: Metadata[],
  boundaryIds: Set<string>,
  hits: Map<string, Metadata>,
) {
  let previous = scan.lastCreatedAt;
  let crossed = false;
  for (const row of rows) {
    if (previous && row.createdAt > previous) throw new IngestFailure("ordering");
    previous = row.createdAt;
    if (row.createdAt < scan.boundary.createdAt) crossed = true;
    if (row.createdAt === scan.boundary.createdAt) boundaryIds.add(row.feedId);
    if (row.createdAt >= scan.boundary.createdAt) {
      const existing = hits.get(row.feedId);
      if (
        existing &&
        (existing.updatedAt !== row.updatedAt || existing.createdAt !== row.createdAt)
      )
        throw new IngestFailure("scan_drift");
      hits.set(row.feedId, row);
    }
  }
  return { previous, crossed };
}
export function pendingBodies(scan: Scan, knownUpdates: ReadonlyMap<string, string>): Metadata[] {
  return scan.hits
    .filter((hit) => knownUpdates.get(hit.feedId) !== hit.updatedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.feedId.localeCompare(b.feedId));
}
// Called only after the full scan has been durably stored, not after body parsing.
export function nextBoundary(scan: Scan): Boundary {
  if (scan.status !== "completed") throw new IngestFailure("boundary_held");
  if (scan.kind === "edit") return scan.boundary;
  if (scan.reason === "boundary_reseeded") return scan.boundary;
  const latest = scan.hits.reduce(
    (at, hit) => (hit.createdAt > at ? hit.createdAt : at),
    scan.boundary.createdAt,
  );
  return {
    createdAt: latest,
    feedIds: [
      ...new Set([
        ...(latest === scan.boundary.createdAt ? scan.boundary.feedIds : []),
        ...scan.hits.filter((hit) => hit.createdAt === latest).map((hit) => hit.feedId),
      ]),
    ].sort(),
  };
}
