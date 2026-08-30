type StagingSiteEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
};

export function stagingDocumentUrl(request: Request): URL | null {
  if (request.method !== "GET") return null;
  const destination = request.headers.get("sec-fetch-dest");
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") === true;
  if (destination !== "document" && !acceptsHtml) return null;

  const url = new URL(request.url);
  if (url.searchParams.get("statsEnv") === "staging") return null;
  url.searchParams.set("statsEnv", "staging");
  return url;
}

export default {
  async fetch(request: Request, env: StagingSiteEnv) {
    const redirect = stagingDocumentUrl(request);
    if (redirect) return Response.redirect(redirect, 307);
    return env.ASSETS.fetch(request);
  },
};
