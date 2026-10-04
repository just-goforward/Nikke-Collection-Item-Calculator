const transientHttp = new Set([429, 500, 502, 503, 504]);
export function retryableRead(code: string | undefined) {
  if (code === "api_transport_timeout" || code === "api_transport_reset") return true;
  const status = /^api_http_(\d+)$/.exec(code ?? "")?.[1];
  return status !== undefined && transientHttp.has(Number(status));
}

export function classifyReadTransport(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const cause = error.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (
    error.name === "TimeoutError" ||
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(String(code))
  )
    return new Error("api_transport_timeout");
  if (code === "ECONNRESET") return new Error("api_transport_reset");
  return error;
}
