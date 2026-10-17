/** Board-11 admission is metadata-only: rejected titles must not trigger detail requests. */
export function board11TitleRelevant(title: string) {
  return (
    (/솔로\s*레이드/.test(title) && /중단|재\s*오픈|재개|후속\s*처리/.test(title)) ||
    /보상\s*(?:지급|안내)/.test(title) ||
    (/기념|축하/.test(title) && /보상|선물|지급/.test(title))
  );
}

export function board11MetadataEligible(title: string, official: boolean) {
  return official && board11TitleRelevant(title);
}

/**
 * Create once per invocation, not once per database binding. Migration results must
 * never survive an invocation because a warm isolate may outlive a migration.
 */
export function board11InvocationGate(db: {
  prepare(sql: string): { first<T>(): Promise<T | null> };
}) {
  let admitted: Promise<boolean> | undefined;
  return () => {
    admitted ??= db
      .prepare("SELECT 1 AS admitted FROM schema_migrations WHERE version >= 27 LIMIT 1")
      .first<{ admitted: number }>()
      .then((row) => row?.admitted === 1);
    return admitted;
  };
}
