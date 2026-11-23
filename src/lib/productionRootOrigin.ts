// Selected only by root-release.vite.config.ts in both the page and Worker graphs.
export const rootCandidate = true;
export const adaptiveShell = true;
export function assertRootCandidateOrigin() {
  if (globalThis.location.origin !== 'https://nikkecollection.com') throw Error('production_root_origin_required');
}
