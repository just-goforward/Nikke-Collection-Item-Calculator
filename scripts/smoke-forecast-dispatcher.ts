const [rawBaseUrl, token, requestKey] = process.argv.slice(2);
if (!rawBaseUrl || !token || !requestKey) {
  throw new Error("Usage: smoke-forecast-dispatcher <collector-url> <admin-token> <request-key>");
}
if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(requestKey)) throw new Error("Invalid smoke request key.");
const baseUrl = rawBaseUrl.replace(/\/$/, "");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const created = await requestJson(`${baseUrl}/admin/dispatcher-smoke`, {
  method: "POST",
  headers,
  body: JSON.stringify({ requestKey }),
});
const dispatchId = isRecord(created) ? created["dispatchId"] : null;
if (typeof dispatchId !== "string" || !/^fd-[0-9a-f]{32}$/.test(dispatchId)) {
  throw new Error("Dispatcher smoke did not return a valid dispatch id.");
}

const deadline = Date.now() + 10 * 60 * 1_000;
let lastState = "pending";
while (Date.now() < deadline) {
  const status = await requestJson(`${baseUrl}/admin/workflow-dispatches/${dispatchId}/status`, {
    headers,
  });
  const dispatch = isRecord(status) && isRecord(status["dispatch"]) ? status["dispatch"] : null;
  lastState = typeof dispatch?.["state"] === "string" ? dispatch["state"] : "missing";
  if (
    lastState === "succeeded" &&
    Number.isInteger(dispatch?.["runId"]) &&
    typeof dispatch?.["discordSentAt"] === "string"
  ) {
    console.log(
      JSON.stringify({
        status: "ok",
        dispatchId,
        runId: dispatch["runId"],
        discordSent: true,
      }),
    );
    process.exit(0);
  }
  if (["failed", "cancelled", "stale"].includes(lastState)) {
    throw new Error(`Dispatcher smoke reached terminal state ${lastState}.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
throw new Error(`Dispatcher smoke timed out in state ${lastState}.`);

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Dispatcher smoke endpoint returned ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 32_768)
    throw new Error("Smoke response is too large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 32_768) throw new Error("Smoke response is too large.");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
