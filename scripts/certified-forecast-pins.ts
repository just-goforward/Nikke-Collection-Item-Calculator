import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type NoticePin = { path: string; bytes: number; sha256: string };
function parsePin(value: unknown): NoticePin {
  if (typeof value !== "object" || value === null)
    throw new Error("certified_forecast_pin_invalid");
  const pin = value as Partial<NoticePin>;
  if (
    typeof pin.path !== "string" ||
    !/^[\w.-]+\.json$/.test(pin.path) ||
    pin.path === "manifest.json" ||
    typeof pin.bytes !== "number" ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 0 ||
    typeof pin.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error("certified_forecast_pin_invalid");
  return { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 };
}

export function assertPinnedCertifiedForecastFiles(manifestPath: string): NoticePin[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: unknown };
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error("certified_forecast_pins_missing");
  const directory = dirname(manifestPath);
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort();
  const pins: NoticePin[] = [];
  for (const value of manifest.files) {
    const pin = parsePin(value);
    const bytes = readFileSync(join(directory, pin.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== pin.bytes || digest !== pin.sha256)
      throw new Error(`certified_forecast_pin_changed:${pin.path}`);
    pins.push(pin);
  }
  const pinnedNames = pins.map((pin) => pin.path).sort();
  if (JSON.stringify(pinnedNames) !== JSON.stringify(names))
    throw new Error("certified_forecast_pin_coverage_mismatch");
  return pins;
}
