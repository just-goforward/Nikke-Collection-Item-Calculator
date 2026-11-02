/** Browser-owned personal state is not used by the current App profile. */
export function createVolatileStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

// Outcome state already lives in the calculator's refs; no second snapshot is needed.
export function setVolatileOutcomeRecovery(_input: unknown): boolean {
  return true;
}

export function reloadWithoutPersonalRecovery(): boolean {
  try {
    location.reload();
    return true;
  } catch {
    return false;
  }
}
