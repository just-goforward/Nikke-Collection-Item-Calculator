type DeferredModule = "SuccessAttemptModal" | "RecommendationContent";
type RecoveryInput = import("./legacyInputRecovery").LegacyRecoveryInput;
let readInput: (() => RecoveryInput | null) | null = null;
let outcomePending = false;

export function bindLegacyInputRecovery(reader: () => RecoveryInput | null) {
  readInput = reader;
  return () => {
    if (readInput === reader) readInput = null;
  };
}

export function saveLegacyInputRecovery(
  input: RecoveryInput | "pending",
  storage: Pick<Storage, "getItem" | "setItem">,
  url: string,
  now = Date.now(),
): boolean {
  if (!Number.isSafeInteger(now)) return false;
  try {
    const raw = JSON.stringify({
      schema: 1,
      revision: "legacy-input-v1",
      savedAt: now,
      url,
      input:
        input === "pending"
          ? input
          : {
              grade: input.grade,
              level: input.level,
              exp: input.exp,
              stock: {
                blue: input.stock.blue,
                purple: input.stock.purple,
                yellow: input.stock.yellow,
              },
            },
    });
    storage.setItem("nikke:legacy-reload-input:v1", raw);
    return storage.getItem("nikke:legacy-reload-input:v1") === raw;
  } catch {
    return false;
  }
}

export function setLegacyOutcomeRecovery(input: RecoveryInput | "pending" | null): boolean {
  outcomePending = input === "pending";
  try {
    if (input)
      return saveLegacyInputRecovery(input, sessionStorage, location.pathname + location.search);
    sessionStorage.removeItem("nikke:legacy-reload-input:v1");
    return true;
  } catch {
    return false;
  }
}

export function reloadWithLegacyInputs(): boolean {
  try {
    const input = outcomePending ? "pending" : readInput?.();
    if (
      !input ||
      !saveLegacyInputRecovery(input, sessionStorage, location.pathname + location.search)
    )
      return false;
    location.reload();
    return true;
  } catch {
    return false;
  }
}

export function lazyModuleRetryUrl(
  error: unknown,
  name: DeferredModule,
  origin: string,
  generation: number,
): string | null {
  if (
    !(error instanceof TypeError) ||
    !/^(Failed to fetch dynamically imported module|error loading dynamically imported module):/i.test(
      error.message,
    ) ||
    (generation !== 1 && generation !== 2)
  )
    return null;
  try {
    const url = new URL(error.message.match(/https?:\/\/[^\s"'<>)]*/)?.[0] ?? "");
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    if (
      !new RegExp(`^/assets/${name}-[A-Za-z0-9_-]+\\.js$`).test(url.pathname) &&
      !(import.meta.env.DEV && url.pathname === `/src/components/${name}.tsx`)
    )
      return null;
    url.searchParams.set("retry", String(generation));
    return url.href;
  } catch {
    return null;
  }
}
