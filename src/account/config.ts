/**
 * The optional Google login / personal workspace UI is OFF unless the page explicitly opts in.
 * Only the staging build injects `window.COLLECTION_ACCOUNT_CONFIG = { enabled: true }`.
 */
export function accountFeatureEnabled(): boolean {
  return window.COLLECTION_ACCOUNT_CONFIG?.enabled === true;
}
