import type { Kit } from "../types";
import { availabilityForKit, RUST_KITS, requireExport } from "./rustCoreShared";
import type { RustCoreExports, Stock } from "./rustTypes";

export function readMomentCovariance(exports: RustCoreExports, mean: Record<Kit, number>) {
  const second = {
    blueBlue: requireExport(exports, "momentSecondBBUses")() * 100,
    purplePurple: requireExport(exports, "momentSecondPPUses")() * 100,
    yellowYellow: requireExport(exports, "momentSecondYYUses")() * 100,
    bluePurple: requireExport(exports, "momentSecondBPUses")() * 100,
    blueYellow: requireExport(exports, "momentSecondBYUses")() * 100,
    purpleYellow: requireExport(exports, "momentSecondPYUses")() * 100,
  };
  return {
    blueBlue: Math.max(0, second.blueBlue - mean.blue * mean.blue),
    purplePurple: Math.max(0, second.purplePurple - mean.purple * mean.purple),
    yellowYellow: Math.max(0, second.yellowYellow - mean.yellow * mean.yellow),
    bluePurple: second.bluePurple - mean.blue * mean.purple,
    blueYellow: second.blueYellow - mean.blue * mean.yellow,
    purpleYellow: second.purpleYellow - mean.purple * mean.yellow,
  };
}

export function availabilityCost(
  vector: Record<Kit, number>,
  stock: Stock,
  horizonFactor: number,
  p: number,
) {
  const ratios = RUST_KITS.map((kit) => {
    const availability = availabilityForKit(stock, kit, horizonFactor);
    if (availability > 0) return vector[kit] / availability;
    return vector[kit] > 1e-12 ? Number.POSITIVE_INFINITY : 0;
  });
  if (!Number.isFinite(p)) return Math.max(...ratios);
  return ratios.reduce((sum, ratio) => sum + ratio ** p, 0) ** (1 / p);
}

export function availabilityHessian(
  mean: Record<Kit, number>,
  stock: Stock,
  horizonFactor: number,
  p: number,
) {
  if (!Number.isFinite(p) || p <= 1) return [0, 0, 0, 0, 0, 0] as const;
  const availability = RUST_KITS.map((kit) => availabilityForKit(stock, kit, horizonFactor));
  if (availability.some((value) => value <= 0)) return [0, 0, 0, 0, 0, 0] as const;
  const c = RUST_KITS.map((kit) => Math.max(0, mean[kit]));
  const w = availability.map((value) => value ** -p);
  const s = c.reduce((total, value, index) => total + (w[index] ?? 0) * value ** p, 0);
  if (s <= 0) return [0, 0, 0, 0, 0, 0] as const;
  const crossFactor = (1 - p) * s ** (1 / p - 2);
  const diagFactor = (p - 1) * s ** (1 / p - 1);
  return [
    hessianDiag(0, c, w, crossFactor, diagFactor, p),
    hessianDiag(1, c, w, crossFactor, diagFactor, p),
    hessianDiag(2, c, w, crossFactor, diagFactor, p),
    hessianOff(0, 1, c, w, crossFactor, p),
    hessianOff(0, 2, c, w, crossFactor, p),
    hessianOff(1, 2, c, w, crossFactor, p),
  ] as const;
}

function hessianDiag(
  index: number,
  c: number[],
  w: number[],
  crossFactor: number,
  diagFactor: number,
  p: number,
) {
  const weight = w[index] ?? 0;
  const consumption = c[index] ?? 0;
  return (
    crossFactor * weight * weight * consumption ** (2 * p - 2) +
    diagFactor * weight * consumption ** Math.max(0, p - 2)
  );
}

function hessianOff(
  i: number,
  j: number,
  c: number[],
  w: number[],
  crossFactor: number,
  p: number,
) {
  return crossFactor * (w[i] ?? 0) * (w[j] ?? 0) * (c[i] ?? 0) ** (p - 1) * (c[j] ?? 0) ** (p - 1);
}
