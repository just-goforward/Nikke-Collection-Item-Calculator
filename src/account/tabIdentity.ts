/**
 * This page's draft identity. Each tab writes its unsynced edits to its own device draft and holds
 * a Web Lock named after it for the page's lifetime, so other tabs can tell a draft of an open tab
 * (left alone) from one whose tab has closed or reloaded (recovered, never overwritten).
 */
export type TabIdentity = {
  id: string;
  /** Draft IDs of tabs that are still open. */
  liveIds(): Promise<ReadonlySet<string>>;
};

const LOCK_PREFIX = "collection-kit-account-tab:";

export function createTabIdentity(): TabIdentity {
  const id = crypto.randomUUID();
  // Never resolves: the browser releases the lock when this page goes away.
  void navigator.locks.request(`${LOCK_PREFIX}${id}`, () => new Promise<never>(() => undefined));
  return {
    id,
    liveIds: async () => {
      const { held = [] } = await navigator.locks.query();
      return new Set(
        held.flatMap(({ name }) =>
          name?.startsWith(LOCK_PREFIX) ? [name.slice(LOCK_PREFIX.length)] : [],
        ),
      );
    },
  };
}
