// Only the isolated root Vite target defines this public verification capability.
declare const __ISOLATED_ROOT_CANDIDATE__: boolean;
export const rootCandidate = typeof __ISOLATED_ROOT_CANDIDATE__ !== 'undefined' && __ISOLATED_ROOT_CANDIDATE__;
export const adaptiveShell = rootCandidate || import.meta.env?.BASE_URL === '/preview/';
export function assertRootCandidateOrigin() {
  if (rootCandidate && !['localhost','127.0.0.1','[::1]'].includes(globalThis.location.hostname))
    throw Error('root_candidate_local_origin_required');
}
