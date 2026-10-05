import type { Q } from "../../shared/certifiedRational";
import type { CertifiedOptions } from "./types";

export class CertifiedLimit extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export class WorkBudget {
  readonly deadlineAt: number;
  readonly maxMemoEntries: number;
  readonly maxSupportPoints: number;
  readonly maxManagedPayloadBytes: number;
  memoEntries = 0;
  exactTransitions = 0;
  supportPeakPoints = 0;
  managedPayloadBytes = 0;
  managedPayloadPeakBytes = 0;
  private externalPayloadBytes = 0;
  kernelCalls = 0;
  private ticks = 0;
  constructor(options: CertifiedOptions, started: number) {
    this.deadlineAt = Math.min(options.deadlineAt ?? started + 15_000, started + 15_000);
    // Four integer fields and numeric keys replace six reduced rational
    // fields/string keys. Admission grows explicitly; the byte ceiling stays
    // unchanged and remains the binding memory safeguard.
    this.maxMemoEntries = Math.min(options.maxMemoEntries ?? 250_000, 250_000);
    this.maxSupportPoints = Math.min(options.maxSupportPoints ?? 25_000, 25_000);
    this.maxManagedPayloadBytes = Math.min(
      options.maxManagedPayloadBytes ?? 192 * 1024 * 1024,
      192 * 1024 * 1024,
    );
    if (
      !Number.isFinite(this.deadlineAt) ||
      !Number.isSafeInteger(this.maxMemoEntries) ||
      !Number.isSafeInteger(this.maxSupportPoints) ||
      !Number.isSafeInteger(this.maxManagedPayloadBytes) ||
      this.maxManagedPayloadBytes < 1 ||
      this.maxMemoEntries < 1 ||
      this.maxSupportPoints < 1
    ) {
      throw new CertifiedLimit("invalid_work_limits");
    }
  }
  check = (): void => {
    if (performance.now() >= this.deadlineAt) throw new CertifiedLimit("request_budget_exhausted");
  };
  tick(): void {
    if (++this.ticks % 32 === 0) this.check();
  }
  reserve(bytes: number): void {
    this.managedPayloadBytes += bytes;
    this.managedPayloadPeakBytes = Math.max(
      this.managedPayloadPeakBytes,
      this.managedPayloadBytes + this.externalPayloadBytes,
    );
    if (this.managedPayloadBytes + this.externalPayloadBytes > this.maxManagedPayloadBytes)
      throw new CertifiedLimit("managed_payload_ceiling");
  }
  canReserve(bytes: number): boolean {
    return (
      this.managedPayloadBytes + this.externalPayloadBytes + bytes <= this.maxManagedPayloadBytes
    );
  }
  setExternalPayload(bytes: number): void {
    this.externalPayloadBytes = bytes;
    this.reserve(0);
  }
  release(bytes: number): void {
    this.managedPayloadBytes = Math.max(0, this.managedPayloadBytes - bytes);
  }
  support(points: number): void {
    this.supportPeakPoints = Math.max(this.supportPeakPoints, points);
    if (points > this.maxSupportPoints) throw new CertifiedLimit("exact_support_limit");
  }
  recordMemo(bytes: number): void {
    if (this.memoEntries >= this.maxMemoEntries) throw new CertifiedLimit("exact_memo_limit");
    this.reserve(bytes);
    this.memoEntries++;
  }
}

/** Account owned numerical payload, including BigInt limbs, tuple slots, and memo key. */
export function rationalPayload(a: Q): number {
  return 32 + Math.ceil((a.n.toString(2).length + a.d.toString(2).length) / 8);
}
