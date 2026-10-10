import { type BrowserContext, expect } from "@playwright/test";

// The approved public metadata GET used by src/certifiedUi/forecastReviewStatus.ts.
// Browser tests serve it locally; the live collector, including its admin routes, stays unreachable.
export const reviewHealthUrl =
  "https://collection-kit-forecast-collector-staging.tbvj159.workers.dev/health";
const reviewCollectorOrigin = new URL(reviewHealthUrl).origin;
const credentialHeaders = ["cookie", "authorization", "proxy-authorization"];

export type ReviewHealthMode = "blocked" | "failed" | "pending" | "current";
export type ReviewHealthAttempt = {
  method: string;
  url: string;
  credentials: string[];
  mode: ReviewHealthMode;
};

const changedSource = { source: "x", itemId: "review-fixture", generation: 1, errorCode: null };
const sourceReview = {
  // An unsettled processor must not be trusted even when it reports pending sources.
  blocked: { state: "review_pending", processingBlocked: true, changedSources: [changedSource] },
  pending: { state: "review_pending", processingBlocked: false, changedSources: [changedSource] },
  current: { state: "current", processingBlocked: false, changedSources: [] },
};

export function isReviewCollector(url: URL) {
  return url.origin === reviewCollectorOrigin;
}

// Register after the catch-all external abort so it takes precedence for the collector origin only.
export async function serveReviewHealth(
  context: BrowserContext,
  mode: () => ReviewHealthMode,
  attempts: ReviewHealthAttempt[],
) {
  // A collector cookie makes any credentialed request observable in the attempt record.
  await context.addCookies([
    {
      name: "review-credential-probe",
      value: "1",
      url: reviewCollectorOrigin,
      secure: true,
      sameSite: "None",
    },
  ]);
  await context.route(isReviewCollector, async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    const served = mode();
    attempts.push({
      method: request.method(),
      url: request.url(),
      credentials: credentialHeaders.filter((name) => name in headers),
      mode: served,
    });
    if (served === "failed" || request.method() !== "GET" || request.url() !== reviewHealthUrl)
      return route.abort("blockedbyclient");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": headers["origin"] ?? "null", vary: "Origin" },
      body: JSON.stringify({ sourceReview: sourceReview[served] }),
    });
  });
}

export function expectApprovedReviewHealthAttempts(
  attempts: readonly ReviewHealthAttempt[],
  message: string,
) {
  expect(
    attempts.map(({ method, url, credentials }) => ({ method, url, credentials })),
    message,
  ).toEqual(attempts.map(() => ({ method: "GET", url: reviewHealthUrl, credentials: [] })));
}
