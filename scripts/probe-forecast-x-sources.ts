import {
  fetchJinaPayload,
  fetchProfilePayload,
  fetchSyndicationPayload,
  fetchXApiPayload,
  type ProbePayload,
} from "./forecast-x-advisory.ts";

const results: Array<{ source: string; result: ProbePayload | { skipped: true } }> = [];
const bearerToken = process.env["X_API_BEARER_TOKEN"]?.trim();
results.push({
  source: "x-api",
  result: bearerToken ? await fetchXApiPayload(bearerToken) : { skipped: true },
});
results.push({ source: "profile-html", result: await fetchProfilePayload() });
results.push({ source: "syndication", result: await fetchSyndicationPayload() });
results.push({ source: "jina", result: await fetchJinaPayload() });

for (const { source, result } of results) {
  if ("skipped" in result) {
    console.log(`${source}: skipped (X_API_BEARER_TOKEN is not configured)`);
    continue;
  }
  const first = result.posts[0];
  console.log(
    JSON.stringify({
      source,
      postCount: result.posts.length,
      reason: result.reason,
      firstStatusUrl: first?.url ?? null,
      firstPublishedAt: first?.publishedAt ?? null,
    }),
  );
}
