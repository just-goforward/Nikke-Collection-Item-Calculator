import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractNoticeText } from "../forecast-collector/src/solo-sections.ts";

type Row = Record<string, any>;
const OUT = "forecast-collector/fixtures/forecast-v2";
const CACHE = "C:/Users/PC/AppData/Local/Temp/nikke-cal-975f2f20/raw";
const FEED = "https://comm-api.game.naver.com/nng_main/v1/community/lounge/nikke/feed";
const SEARCH = "https://comm-api.game.naver.com/nng_main/v2/search/feeds";
const cutoff = "20241001";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pick = (value: Row, keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
const day = (value: string) => value.replace(/\D/g, "").slice(0, 8);

export function sanitizeDetail(raw: Row) {
  assert.equal(raw["code"], 200);
  const { feed, board, user } = raw["content"];
  assert.equal(user.userRoleCode, "game_manager");
  const sanitized = {
    code: raw["code"],
    content: {
      feed: pick(feed, ["feedId", "title", "createdDate", "updatedDate", "contents"]),
      board: pick(board, ["boardId", "boardName", "type"]),
      user: { userRoleCode: user.userRoleCode },
    },
  };
  assert.deepEqual(
    extractNoticeText(feed.contents),
    extractNoticeText(sanitized.content.feed["contents"]),
  );
  return sanitized;
}

export function sanitizePage(raw: Row, list = false) {
  assert.equal(raw["code"], 200);
  assert.ok(Array.isArray(raw["content"].feeds));
  return {
    code: raw["code"],
    content: {
      ...pick(raw["content"], ["totalCount", "total", "offset", "limit", "hasMore"]),
      feeds: raw["content"].feeds
        .filter((row: Row) => row["user"]?.userRoleCode === "game_manager")
        .map((row: Row) => {
          const feed = list ? row["feed"] : row;
          return {
            ...pick(feed, ["feedId", "title", "createdDate", "updatedDate", "previewText"]),
            boardId: row["board"].boardId,
            userRoleCode: row["user"].userRoleCode,
          };
        }),
    },
  };
}

function inventory(dir: string, existing: Map<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (path.replaceAll("\\", "/") === OUT) continue;
    if (entry.isDirectory()) inventory(path, existing);
    else if (/^(?:naver-detail-)?\d+\.json$/.test(entry.name)) {
      const id = entry.name.match(/\d+/)![0];
      existing.set(id, path.replaceAll("\\", "/"));
    }
  }
}
function addCalendarIds(requested: Set<string>) {
  const calendar = readFileSync(".artifacts/forecast-calendar-2y.html", "utf8");
  for (const name of ["SOLO", "COLLAB", "KITS", "B11"]) {
    const body = calendar.split(`const ${name} = [`)[1]?.split("\n];")[0];
    assert.ok(body, name);
    for (const match of body.matchAll(/\b\d{7}\b/g)) requested.add(match[0]);
  }
}

function createCaptureIO(records: Row[], initialRequestCount: number) {
  let requestCount = initialRequestCount;
  let lastRequest = 0;
  async function get(url: string) {
    assert.ok(requestCount < 300, "request budget exhausted");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 1050 - (Date.now() - lastRequest))),
    );
    lastRequest = Date.now();
    requestCount++;
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        origin: "https://game.naver.com",
        referer: "https://game.naver.com/",
        "user-agent": "collection-kit-forecast-collector/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });
    // Stricter than the burst limit: stop on the first HTTP error, without retries.
    assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 2_000_000, "response too large");
    return { text, acquiredAt: new Date().toISOString(), origin: "network" };
  }
  function save(path: string, source: Row, sanitized: Row, url: string, extra: Row = {}) {
    const text = `${JSON.stringify(sanitized, null, 2)}\n`;
    writeFileSync(`${OUT}/${path}`, text, { flag: "wx" });
    records.push({
      path,
      url,
      acquiredAt: source["acquiredAt"],
      acquisition: source["origin"],
      rawSha256: hash(source["text"]),
      sanitizedSha256: hash(text),
      normalizedTextHash: sanitized["content"].feed
        ? hash(extractNoticeText(sanitized["content"].feed.contents).effective)
        : hash(
            JSON.stringify(
              sanitized["content"].feeds.map((row: Row) => [
                row["title"],
                row["previewText"] ?? "",
              ]),
            ),
          ),
      requestCount: source["origin"] === "network" ? 1 : 0,
      ...extra,
    });
  }
  return { get, save, requestCount: () => requestCount };
}

type CaptureIO = ReturnType<typeof createCaptureIO>;

async function captureSearches(requested: Set<string>, searches: Row[], { get, save }: CaptureIO) {
  const monitors = [
    ["A", 11, "관리 키트", "COMMUNITY_FEED_TITLE_CONTENT"],
    ["B", 11, "솔로 레이드", "COMMUNITY_FEED_TITLE"],
    ["C-open", 56, "솔로 레이드 오픈", "COMMUNITY_FEED_TITLE_CONTENT"],
    ["C-reopen", 56, "솔로 레이드 재오픈", "COMMUNITY_FEED_TITLE_CONTENT"],
    ["D", 56, "콜라보", "COMMUNITY_FEED_TITLE_CONTENT"],
    ["E", 48, "솔로 레이드 시즌", "COMMUNITY_FEED_TITLE_CONTENT"],
    ["F", 48, "관리 키트", "COMMUNITY_FEED_TITLE_CONTENT"],
  ] as const;
  for (const [monitor, boardId, keyword, searchOption] of monitors) {
    if (searches.some((search) => search["monitor"] === monitor && search["complete"])) continue;
    const ids: number[] = [];
    let complete = false;
    for (let offset = 0; !complete; offset += 100) {
      const url = `${SEARCH}?${new URLSearchParams({
        loungeId: "nikke",
        boardId: String(boardId),
        keyword,
        searchOption,
        orderType: "LATEST",
        offset: String(offset),
        limit: "100",
      })}`;
      const source = await get(url);
      const raw = JSON.parse(source.text);
      const sanitized = sanitizePage(raw);
      save(`search-${monitor}-${offset}.json`, source, sanitized, url, { monitor, offset });
      for (const row of sanitized.content.feeds) {
        assert.equal(row.boardId, boardId);
        if (day(row.createdDate) >= cutoff) {
          ids.push(row.feedId);
          requested.add(String(row.feedId));
        }
      }
      complete =
        raw.content.feeds.length < 100 ||
        raw.content.feeds.some((row: Row) => day(row["createdDate"]) < cutoff);
    }
    searches.push({ monitor, boardId, keyword, searchOption, feedIds: ids, complete });
  }
}

async function captureBoard(requested: Set<string>, { get, save }: CaptureIO) {
  for (let page = 0; ; page++) {
    const url = `${FEED}?${new URLSearchParams({
      boardId: "48",
      buffFilteringYN: "N",
      limit: "10",
      offset: String(page),
      order: "NEW",
    })}`;
    const source = await get(url);
    const raw = JSON.parse(source.text);
    const sanitized = sanitizePage(raw, true);
    save(`board48-limit10-${page}.json`, source, sanitized, url, { pageIndex: page });
    for (const row of sanitized.content.feeds) {
      if (day(row.createdDate) >= cutoff && /점검/.test(row.title))
        requested.add(String(row.feedId));
    }
    if (
      raw.content.feeds.length < 10 ||
      raw.content.feeds.some((row: Row) => row["feed"] && day(row["feed"].createdDate) < cutoff)
    )
      break;
  }
}

async function captureDetails(
  requested: Set<string>,
  existing: Map<string, string>,
  referenced: Row[],
  notFound: string[],
  { get, save }: CaptureIO,
) {
  mkdirSync(`${OUT}/details`, { recursive: true });
  for (const id of requested) {
    const previous = existing.get(id);
    if (previous) {
      const bytes = readFileSync(previous);
      const payload = JSON.parse(bytes.toString());
      assert.equal(String(payload.content.feed.feedId), id);
      assert.equal(payload.content.user.userRoleCode, "game_manager");
      referenced.push({ feedId: id, path: previous, sha256: hash(bytes) });
      continue;
    }
    const url = `${FEED}/${id}`;
    const cached = `${CACHE}/${id}.json`;
    const source = existsSync(cached)
      ? {
          text: readFileSync(cached, "utf8"),
          acquiredAt: statSync(cached).mtime.toISOString(),
          origin: "prior-cache",
          acquisitionTimeBasis: "cache file mtime",
        }
      : await get(url);
    const raw = JSON.parse(source.text);
    if (raw.code !== 200 || !raw.content?.feed) {
      notFound.push(id);
      throw new Error(`detail unavailable ${id}, code ${raw.code}`);
    }
    assert.equal(String(raw.content.feed.feedId), id);
    save(`details/${id}.json`, source, sanitizeDetail(raw), url, {
      feedId: id,
      ...(source.origin === "prior-cache" ? { acquisitionTimeBasis: "cache file mtime" } : {}),
    });
  }
}

type ManifestState = {
  startedAt: string;
  requestCount: number;
  searches: Row[];
  requested: Set<string>;
  referenced: Row[];
  notFound: string[];
  records: Row[];
  failure: string | null;
  prior: any;
};

function writeManifest({
  startedAt,
  requestCount,
  searches,
  requested,
  referenced,
  notFound,
  records,
  failure,
  prior,
}: ManifestState) {
  writeFileSync(
    `${OUT}/manifest.json`,
    `${JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        windowStart: "2024-10-01",
        windowEnd: startedAt,
        requestCount,
        priorCacheRequestCount: "unknown (pre-existing acquisition)",
        bounds: { maxRequests: 300, minimumSpacingMs: 1050, attempts: 1, method: "GET" },
        rawPagePolicy:
          "Original envelope code and verbatim title/preview markup retained; identifiers and non-manager rows removed. Unsanitized pages are not persisted.",
        normalizedTextHashPolicy:
          "Details: extractNoticeText(contents).effective; pages: JSON of title/preview pairs",
        searches,
        requestedIds: [...requested],
        referenced,
        notFound,
        records,
        failure,
        priorAttempts: prior
          ? [
              {
                requestCount: prior.requestCount,
                failure: prior.failure,
                completedAt: prior.completedAt,
                recovery: "Board list reduced from 30 to 10 rows",
              },
            ]
          : [],
      },
      null,
      2,
    )}\n`,
  );
}

async function capture() {
  const prior = existsSync(`${OUT}/manifest.json`)
    ? JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"))
    : null;
  assert.ok(
    !prior || prior.failure === "AssertionError [ERR_ASSERTION]: response too large",
    "Only the recorded oversized-list failure can be resumed",
  );
  mkdirSync(OUT, { recursive: true });
  const startedAt = prior?.startedAt ?? new Date().toISOString();
  const records: Row[] = prior?.records ?? [];
  const searches: Row[] = prior?.searches ?? [];
  const referenced: Row[] = [];
  const notFound: string[] = [];
  const requested = new Set<string>(prior?.requestedIds ?? []);
  let failure: string | null = null;
  const existing = new Map<string, string>();
  inventory("forecast-collector/fixtures", existing);
  addCalendarIds(requested);
  const io = createCaptureIO(records, prior?.requestCount ?? 0);
  try {
    await captureSearches(requested, searches, io);
    await captureBoard(requested, io);
    await captureDetails(requested, existing, referenced, notFound, io);
  } catch (error) {
    failure = String(error);
  } finally {
    writeManifest({
      startedAt,
      requestCount: io.requestCount(),
      searches,
      requested,
      referenced,
      notFound,
      records,
      failure,
      prior,
    });
  }
  console.log(
    JSON.stringify({
      requestCount: io.requestCount(),
      capturedIds: records.filter((record) => record["feedId"]).map((record) => record["feedId"]),
      referencedIds: referenced.map((record) => record["feedId"]),
      notFound,
      failure,
    }),
  );
  if (failure) throw new Error(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await capture();
