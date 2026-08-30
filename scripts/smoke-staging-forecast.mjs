const baseUrl = new URL(process.argv[2]);
const expectedForecastId = process.argv[3];
const expectedRevision = process.argv[4];

if (
  baseUrl.protocol !== "https:" ||
  !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(baseUrl.hostname)
) {
  throw new Error("Staging URL must be an HTTPS workers.dev origin.");
}
if (!/^supply-\d{4}-\d{2}-\d{2}-v\d+$/.test(expectedForecastId ?? "")) {
  throw new Error("Expected staging forecast ID is invalid.");
}
if (!/^[0-9a-f]{40}$/.test(expectedRevision ?? "")) {
  throw new Error("Expected staging revision is invalid.");
}

let lastError;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const markerResponse = await fetch(new URL("staging-forecast.json", baseUrl), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!markerResponse.ok) throw new Error(`staging marker returned ${markerResponse.status}`);
    const marker = await markerResponse.json();
    if (
      marker?.environment !== "staging" ||
      marker?.forecastId !== expectedForecastId ||
      marker?.revision !== expectedRevision ||
      marker?.productAdoptionAuthorized !== false
    ) {
      throw new Error("staging marker contract mismatch");
    }
    const redirectResponse = await fetch(baseUrl, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (redirectResponse.status !== 307)
      throw new Error("staging page did not select staging stats");
    const redirectUrl = new URL(redirectResponse.headers.get("location") ?? "", baseUrl);
    if (redirectUrl.searchParams.get("statsEnv") !== "staging") {
      throw new Error("staging page selected the wrong stats environment");
    }
    const pageResponse = await fetch(redirectUrl, { signal: AbortSignal.timeout(10_000) });
    if (!pageResponse.ok) throw new Error(`staging page returned ${pageResponse.status}`);
    if (pageResponse.headers.get("x-robots-tag") !== "noindex, nofollow") {
      throw new Error("staging page is missing X-Robots-Tag");
    }
    const robotsResponse = await fetch(new URL("robots.txt", baseUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    const robots = await robotsResponse.text();
    if (!robots.includes("Disallow: /")) throw new Error("staging robots policy is not closed");
    console.log(JSON.stringify(marker));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

throw lastError;
