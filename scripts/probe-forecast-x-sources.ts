import { fetchXAdvisoryPayload } from "./forecast-x-advisory.ts";

const result = await fetchXAdvisoryPayload();
const first = result.posts[0];
console.log(
  JSON.stringify({
    source: "fxtwitter",
    postCount: result.posts.length,
    reason: result.reason,
    firstStatusUrl: first?.url ?? null,
    firstPublishedAt: first?.publishedAt ?? null,
  }),
);
