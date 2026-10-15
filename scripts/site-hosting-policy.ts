import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Unset preserves the legacy Pages publisher until the separately approved cutover. */
export function pagesPublicationPolicy(target: string | undefined) {
  if (target !== undefined && target !== "" && target !== "pages" && target !== "worker") {
    throw new Error("SITE_HOSTING_TARGET must be pages, worker, or unset.");
  }
  const publishPages = target !== "worker";
  return { publishPages, smokePages: publishPages, retainRollbackArtifact: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = pagesPublicationPolicy(process.env["SITE_HOSTING_TARGET"]);
  const output = process.env["GITHUB_OUTPUT"];
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    output,
    `publish_pages=${policy.publishPages}\nretain_rollback_artifact=${policy.retainRollbackArtifact}\n`,
  );
}
