import manifest from "../../../../fixtures/forecast-v2/manifest.json";

// Test-only adapter for the sanitized S0 capture. Sanitization removed the
// lounge identity from rows; it is re-added, in the live nested
// `lounge.loungeId` shape (plan §7C F7), from the manifest's recorded request
// URL (search `loungeId=` query or `/lounge/<id>/feed` path), never from a
// constant, so a fixture captured from another lounge stays foreign.
const prefix = "../../../../fixtures/forecast-v2/";
const loaders = import.meta.glob<unknown>(
  ["../../../../fixtures/forecast-v2/*.json", "../../../../fixtures/forecast-v2/details/*.json"],
  { import: "default" },
);
type ManifestRecord = {
  path: string;
  url: string;
  monitor?: string;
  pageIndex?: number;
  feedId?: string;
};
const manifestRecords: ManifestRecord[] = manifest.records;
const records = new Map(manifestRecords.map((record) => [record.path, record]));

export function loungeFromRequestUrl(url: string): string {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("loungeId");
  const path = /\/lounge\/([^/]+)\/feed(?:\/\d+)?$/.exec(parsed.pathname)?.[1] ?? null;
  const lounge = query ?? path;
  if (!lounge || (query !== null && path !== null && query !== path))
    throw new Error(`fixture_lounge_unknown:${url}`);
  return lounge;
}

export function fixtureRecord(path: string): ManifestRecord {
  const record = records.get(path);
  if (!record) throw new Error(`fixture_not_in_manifest:${path}`);
  return record;
}

/** Manifest paths that exist under fixtures/forecast-v2 and match the pattern. */
export function fixturePaths(pattern: RegExp): string[] {
  return [...records.keys()]
    .filter((path) => pattern.test(path) && `${prefix}${path}` in loaders)
    .sort();
}

type Envelope = {
  code: unknown;
  content: {
    feeds?: Record<string, unknown>[];
    feed?: Record<string, unknown>;
    lounge?: { loungeId: string };
  };
};

export async function rawFixture(path: string): Promise<Envelope> {
  const load = loaders[`${prefix}${path}`];
  if (!load) throw new Error(`fixture_missing:${path}`);
  return structuredClone((await load()) as Envelope);
}

/** Fixture payload with the lounge identity restored from its manifest request URL. */
export async function fixture(path: string): Promise<Envelope> {
  const lounge = loungeFromRequestUrl(fixtureRecord(path).url);
  const payload = await rawFixture(path);
  if (Array.isArray(payload.content.feeds)) {
    for (const row of payload.content.feeds) row["lounge"] = { loungeId: lounge };
  } else if (payload.content.feed) payload.content.lounge = { loungeId: lounge };
  else throw new Error(`fixture_shape:${path}`);
  return payload;
}

export const detailPath = (feedId: number | string) => `details/${feedId}.json`;
export const hasFixture = (path: string) => records.has(path) && `${prefix}${path}` in loaders;
