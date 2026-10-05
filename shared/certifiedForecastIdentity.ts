import { assertCertifiedSupplySnapshot, type CertifiedSupplySnapshot } from "./certifiedSupply";

export type CertifiedForecastIdentity = {
  forecastId: string;
  snapshotRevision: string;
  sourceHash: string;
  snapshotHash: string;
};
const fields = ["forecastId", "snapshotRevision", "sourceHash", "snapshotHash"] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function workspace(value: unknown): { json: number; copies: number } {
  if (typeof value === "string") return { json: 2 + value.length * 6, copies: 0 };
  if (value === null || typeof value !== "object") return { json: 32, copies: 0 };
  let json = 2,
    copies = 64;
  if (Array.isArray(value)) {
    for (const item of value) {
      const child = workspace(item);
      json += child.json + 1;
      copies += child.copies + 96;
    }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = workspace(Reflect.get(value, key));
      json += child.json + 1 + key.length * 6 + 3;
      copies += child.copies + 96;
    }
  }
  return { json, copies };
}

/** Conservative managed workspace reservation, including canonical containers and worst-case escaping. */
export function certifiedForecastIdentityWorkspaceBound(input: CertifiedSupplySnapshot): number {
  const estimate = workspace(input);
  return estimate.json * 3 + estimate.copies;
}

/** Every semantic date participates; only the top-level generation timestamp is excluded. */
export async function createCertifiedForecastIdentity(
  input: CertifiedSupplySnapshot,
  trackTransientBytes?: (ownedBytes: number) => void,
): Promise<CertifiedForecastIdentity> {
  const snapshot = assertCertifiedSupplySnapshot(input);
  try {
    // Reserve before constructing JSON, its UTF8 copy, or sorted containers. Keep
    // the conservative reservation until digest settlement, also during cancellation.
    trackTransientBytes?.(certifiedForecastIdentityWorkspaceBound(snapshot));
    const semantic = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== "generatedAt"),
    );
    const contents = JSON.stringify(canonical(semantic));
    const encoded = new TextEncoder().encode(contents);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return {
      forecastId: snapshot.revision,
      snapshotRevision: snapshot.revision,
      sourceHash: snapshot.sourceHash,
      snapshotHash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  } finally {
    trackTransientBytes?.(0);
  }
}

export function assertCertifiedForecastIdentity(value: unknown): CertifiedForecastIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length
  ) {
    throw new TypeError("certified_forecast_identity_mismatch");
  }
  for (const key of fields) {
    const field = Reflect.get(value, key);
    if (
      typeof field !== "string" ||
      !field ||
      field.length > 1024 ||
      (key.endsWith("Hash") && !/^[a-f0-9]{64}$/.test(field))
    ) {
      throw new TypeError("certified_forecast_identity_mismatch");
    }
  }
  return {
    forecastId: Reflect.get(value, "forecastId"),
    snapshotRevision: Reflect.get(value, "snapshotRevision"),
    sourceHash: Reflect.get(value, "sourceHash"),
    snapshotHash: Reflect.get(value, "snapshotHash"),
  };
}

export function sameCertifiedForecastIdentity(
  a: CertifiedForecastIdentity,
  b: CertifiedForecastIdentity,
): boolean {
  return fields.every((key) => a[key] === b[key]);
}
